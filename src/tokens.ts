import type { Env } from './types';

/**
 * API 令牌：给「无面板管理」用 —— 命令行、脚本、CI 直接带
 *   Authorization: Bearer pan_xxx
 * 就能调管理接口，不需要浏览器 Cookie。
 *
 * 安全约定：
 *  - 令牌明文只在创建时返回一次，库里只存 sha256 十六进制。
 *  - scopes 逗号分隔，目前支持 `read` / `manage`（manage 含 read）。
 *  - 删掉或 enabled=0 立即失效。
 */

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
  created_by: string | null;
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randHex(n: number): string {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function parseScopes(s: string | null | undefined): string[] {
  const arr = String(s || '')
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const out: string[] = [];
  for (const a of arr) {
    if (a === 'manage' && !out.includes('manage')) out.push('manage');
    else if (a === 'read' && !out.includes('read')) out.push('read');
  }
  if (out.includes('manage') && !out.includes('read')) out.unshift('read');
  if (!out.length) out.push('read');
  return out;
}

export async function createApiToken(
  env: Env,
  name: string,
  scopes: string[],
  createdBy: string | null,
): Promise<{ id: string; token: string; prefix: string; name: string; scopes: string[] }> {
  const cleanName = String(name || '').trim().slice(0, 60) || '未命名令牌';
  const sc = parseScopes(scopes.join(','));
  const raw = 'pan_' + randHex(24);
  const id = crypto.randomUUID();
  const prefix = raw.slice(0, 12);
  const hash = await sha256hex(raw);
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, enabled, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, cleanName, prefix, hash, sc.join(','), new Date().toISOString(), createdBy || 'admin')
    .run();
  return { id, token: raw, prefix, name: cleanName, scopes: sc };
}

export async function listApiTokens(env: Env): Promise<ApiTokenRow[]> {
  const r = await env.DB.prepare(
    'SELECT id, name, prefix, scopes, enabled, created_at, last_used_at, created_by FROM api_tokens ORDER BY created_at DESC',
  ).all<any>();
  return (r.results || []) as ApiTokenRow[];
}

/** 验令牌：有效返回 { id, name, scopes }，否则 null。顺带记 last_used_at。 */
export async function verifyApiToken(
  env: Env,
  raw: string,
): Promise<{ id: string; name: string; scopes: string[] } | null> {
  const t = String(raw || '').trim();
  if (!t.startsWith('pan_')) return null;
  const hash = await sha256hex(t);
  const row = await env.DB.prepare(
    'SELECT id, name, scopes, enabled FROM api_tokens WHERE token_hash = ?',
  )
    .bind(hash)
    .first<any>();
  if (!row || !row.enabled) return null;
  // 最后使用时间：不阻塞主流程
  try {
    await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), row.id)
      .run();
  } catch {
    /* 记录失败不影响鉴权 */
  }
  return { id: row.id, name: row.name, scopes: parseScopes(row.scopes) };
}

export async function revokeApiToken(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function setApiTokenEnabled(env: Env, id: string, enabled: boolean): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE api_tokens SET enabled = ? WHERE id = ?')
    .bind(enabled ? 1 : 0, id)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}
