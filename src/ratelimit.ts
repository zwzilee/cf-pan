import type { Env } from './types';

/**
 * 登录限流：KV 计数。
 *
 * 两层桶，任一层超限就拒绝：
 *   1) 账号桶  login:u:<sha1(username)>   —— 防盯着一个用户名慢慢试
 *   2) IP 桶   login:ip:<sha1(ip)>        —— 防换着用户名撞库
 *
 * 每次失败 +1，10 分钟滑动窗口（KV 的 expirationTtl 最短 60s，这里用固定窗口：
 * 首次失败写 {n:1,t:now}，超过 WINDOW 秒就重新计）。
 * 登录成功时清掉账号桶（IP 桶保留，避免同一个 IP 拿已知账号去刷别人的）。
 */

export const MAX_FAILS = 5; // 5 次错
export const WINDOW_SEC = 600; // 锁 10 分钟

type Bucket = { n: number; t: number };

const enc = new TextEncoder();

async function sha1Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 用户名不区分大小写归一，IP 直接原串 */
async function keys(username: string, ip: string): Promise<[string, string]> {
  const u = await sha1Hex(username.trim().toLowerCase());
  const i = await sha1Hex(ip.trim());
  return [`login:u:${u}`, `login:ip:${i}`];
}

async function readBucket(env: Env, key: string): Promise<Bucket> {
  const raw = await env.KV.get(key);
  if (!raw) return { n: 0, t: 0 };
  try {
    const b = JSON.parse(raw) as Bucket;
    return { n: Number(b.n) || 0, t: Number(b.t) || 0 };
  } catch {
    return { n: 0, t: 0 };
  }
}

export type LockInfo = { locked: boolean; retryAfter: number; scope?: 'account' | 'ip'; fails?: number };

/** 登录前问一句：现在还能试吗？返回剩余锁定秒数。 */
export async function checkLoginAllowed(env: Env, username: string, ip: string): Promise<LockInfo> {
  const now = Math.floor(Date.now() / 1000);
  const [uk, ik] = await keys(username, ip);

  for (const [scope, key] of [['account', uk], ['ip', ik]] as const) {
    const b = await readBucket(env, key);
    if (b.n >= MAX_FAILS) {
      const left = WINDOW_SEC - (now - b.t);
      if (left > 0) return { locked: true, retryAfter: left, scope, fails: b.n };
      // 窗口过了，顺手清掉
      await env.KV.delete(key);
    }
  }
  return { locked: false, retryAfter: 0 };
}

/** 记一次失败，返回这条桶还剩几次机会 */
export async function recordLoginFailure(env: Env, username: string, ip: string): Promise<{ left: number; ipLeft: number }> {
  const now = Math.floor(Date.now() / 1000);
  const [uk, ik] = await keys(username, ip);

  const bump = async (key: string): Promise<number> => {
    const b = await readBucket(env, key);
    const within = b.t && now - b.t < WINDOW_SEC;
    const next: Bucket = within ? { n: b.n + 1, t: b.t } : { n: 1, t: now };
    const ttl = within ? Math.max(60, WINDOW_SEC - (now - b.t)) : WINDOW_SEC;
    await env.KV.put(key, JSON.stringify(next), { expirationTtl: ttl });
    return Math.max(0, MAX_FAILS - next.n);
  };

  return { left: await bump(uk), ipLeft: await bump(ik) };
}

/** 登录成功：清掉账号桶（IP 桶留着） */
export async function clearLoginFailures(env: Env, username: string): Promise<void> {
  const u = await sha1Hex(username.trim().toLowerCase());
  await env.KV.delete(`login:u:${u}`);
}

/** 从请求里取客户端 IP（Cloudflare 会填 CF-Connecting-IP） */
export function clientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ||
    (req.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}
