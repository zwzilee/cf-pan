import type { Env } from './types';

/**
 * 登录限流：KV 计数。
 *
 * 两层桶，任一层超限就拒绝：
 *   1) 账号桶  login:u:<sha1(username)>  MAX_ACCOUNT_FAILS = 5    —— 防盯着一个用户名慢慢试
 *   2) IP 桶   login:ip:<sha1(ip)>       MAX_IP_FAILS = 100       —— 只挡真正的暴力撞库
 *
 * IP 桶放宽到 100 是因为共享出口（家宽 NAT、公司网关、运营商 CGNAT）后面可能坐着好几个人，
 * 5 次就锁会把无辜的人一起关在外面；账号桶 5 次仍是硬线，谁也撞不开单个账号。
 *
 * 固定窗口：首次失败写 {n:1,t:now}，超过 WINDOW 秒重新计（KV 的 expirationTtl 最短 60s，
 * 做不了精确滑动窗口，对付撞库够用）。登录成功清账号桶、保留 IP 桶。
 */

export const MAX_ACCOUNT_FAILS = 5; // 单个账号 5 次错
export const MAX_IP_FAILS = 100; // 单个 IP 100 次错
export const WINDOW_SEC = 600; // 都锁 10 分钟

/** 兼容旧引用 */
export const MAX_FAILS = MAX_ACCOUNT_FAILS;

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

  const buckets = [
    ['account', uk, MAX_ACCOUNT_FAILS],
    ['ip', ik, MAX_IP_FAILS],
  ] as const;

  for (const [scope, key, max] of buckets) {
    const b = await readBucket(env, key);
    if (b.n >= max) {
      const left = WINDOW_SEC - (now - b.t);
      if (left > 0) return { locked: true, retryAfter: left, scope, fails: b.n };
      await env.KV.delete(key); // 窗口过了，顺手清掉
    }
  }
  return { locked: false, retryAfter: 0 };
}

/** 记一次失败，返回两条桶各自还剩几次机会 */
export async function recordLoginFailure(
  env: Env,
  username: string,
  ip: string,
): Promise<{ left: number; ipLeft: number }> {
  const now = Math.floor(Date.now() / 1000);
  const [uk, ik] = await keys(username, ip);

  const bump = async (key: string, max: number): Promise<number> => {
    const b = await readBucket(env, key);
    const within = b.t && now - b.t < WINDOW_SEC;
    const next: Bucket = within ? { n: b.n + 1, t: b.t } : { n: 1, t: now };
    const ttl = within ? Math.max(60, WINDOW_SEC - (now - b.t)) : WINDOW_SEC;
    await env.KV.put(key, JSON.stringify(next), { expirationTtl: ttl });
    return Math.max(0, max - next.n);
  };

  return { left: await bump(uk, MAX_ACCOUNT_FAILS), ipLeft: await bump(ik, MAX_IP_FAILS) };
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
