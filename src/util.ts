export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers as any);
  if (!h.has('Content-Type')) h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers: h });
}

/** bytes -> base64url（无填充） */
export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url -> bytes */
export function b64urlDecode(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function getCookie(req: Request, name: string): string | null {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

/** expires 传 0 表示立刻过期（登出清 Cookie），不依赖 Max-Age 的浏览器兼容性 */
export function cookie(name: string, value: string, maxAge: number): string {
  const exp = maxAge > 0 ? new Date(Date.now() + maxAge * 1000).toUTCString() : 'Thu, 01 Jan 1970 00:00:00 GMT';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${exp}`;
}

export class Need extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 设置表的读写（settings: 键值对） */
export async function getSetting(env: { DB: D1Database }, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<any>();
  return r?.value ?? null;
}

export async function setSetting(env: { DB: D1Database }, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
    .bind(key, value, nowISO())
    .run();
}

export function nowISO(): string {
  return new Date().toISOString();
}
