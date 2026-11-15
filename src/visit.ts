import type { Env } from './types';
import { nowISO } from './util';
import { clientIp } from './ratelimit';

/**
 * 访问日志：每次 /api/* 请求落一条到 D1 的 visits 表。
 *
 * 为什么落 D1 而不是 KV：要按时间倒序查「最近谁来过」，KV 只能 list key 不能排序/过滤；
 * D1 一条 SELECT ORDER BY id DESC LIMIT n 就够了，而且已经有备份链路。
 * 写入用 ctx.waitUntil 异步做，不拖慢响应。
 */

export type VisitRow = {
  id: number;
  ip: string;
  country: string | null;
  city: string | null;
  ua: string | null;
  method: string;
  path: string;
  status: number;
  uid: number | null;
  username: string | null;
  referer: string | null;
  created_at: string;
};

const MAX_UA = 300;
const MAX_PATH = 300;

function clip(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

/** 记一条访问（拿不到 uid 就写 null；IP 永远有值） */
export async function logVisit(
  env: Env,
  req: Request,
  res: Response,
  ctx: { uid?: number; username?: string } | null,
): Promise<void> {
  try {
    const url = new URL(req.url);
    await env.DB.prepare(
      `INSERT INTO visits (ip, country, city, ua, method, path, status, uid, username, referer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        clientIp(req),
        (req as any).cf?.country ?? null,
        (req as any).cf?.city ?? null,
        clip(req.headers.get('User-Agent'), MAX_UA),
        req.method,
        clip(url.pathname + (url.search || ''), MAX_PATH),
        res.status,
        ctx?.uid ?? null,
        ctx?.username ?? null,
        clip(req.headers.get('Referer'), MAX_PATH),
        nowISO(),
      )
      .run();
  } catch {
    // 日志失败不许影响主流程
  }
}

export async function listVisits(env: Env, limit = 100, offset = 0): Promise<VisitRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM visits ORDER BY id DESC LIMIT ? OFFSET ?',
  )
    .bind(Math.min(Math.max(limit, 1), 500), Math.max(offset, 0))
    .all<VisitRow>();
  return results;
}

/** 聚合：按 IP 统计最近 N 条里的次数、首次/末次时间 */
export async function summarizeVisits(env: Env, window = 1000): Promise<
  { ip: string; hits: number; last: string; country: string | null; agents: number }[]
> {
  const { results } = await env.DB.prepare(
    `SELECT ip,
            COUNT(*) AS hits,
            MAX(created_at) AS last,
            MAX(country) AS country,
            COUNT(DISTINCT ua) AS agents
       FROM (SELECT * FROM visits ORDER BY id DESC LIMIT ?)
      GROUP BY ip
      ORDER BY hits DESC, last DESC`,
  )
    .bind(Math.min(Math.max(window, 1), 5000))
    .all<any>();
  return results as any;
}

/** 清掉超过 days 天的记录，返回删了多少行 */
export async function pruneVisits(env: Env, days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const r = await env.DB.prepare('DELETE FROM visits WHERE created_at < ?').bind(cutoff).run();
  return r.meta.changes ?? 0;
}

/** 现在的登录锁状态（KV 里两条桶），给后台看 */
export async function lockStatus(env: Env, username: string, ip: string): Promise<{
  account: { fails: number; lockedFor: number } | null;
  ipBucket: { fails: number; lockedFor: number } | null;
}> {
  const enc = new TextEncoder();
  const sha = async (s: string) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(s)))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const now = Math.floor(Date.now() / 1000);

  const read = async (key: string) => {
    const raw = await env.KV.get(key);
    if (!raw) return null;
    try {
      const b = JSON.parse(raw) as { n: number; t: number };
      const left = 600 - (now - b.t);
      return { fails: b.n, lockedFor: b.n >= 5 && left > 0 ? left : 0 };
    } catch {
      return null;
    }
  };

  return {
    account: username ? await read(`login:u:${await sha(username.trim().toLowerCase())}`) : null,
    ipBucket: ip ? await read(`login:ip:${await sha(ip.trim())}`) : null,
  };
}
