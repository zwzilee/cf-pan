import { b64url, b64urlDecode, cookie, getCookie, HttpError } from './util';
import type { Env } from './types';

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** 极简 HS256 JWT 签发 */
export async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJWT(token: string, secret: string): Promise<any> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new HttpError(401, '无效令牌');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(s), enc.encode(`${h}.${p}`));
  if (!ok) throw new HttpError(401, '令牌校验失败');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  if (payload.exp && Date.now() > payload.exp * 1000) throw new HttpError(401, '登录已过期');
  return payload;
}

/** PBKDF2-SHA256 口令哈希 */
export async function hashPassword(pw: string, iterations = 100000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256),
  );
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, iterStr, saltB, hashB] = stored.split('$');
  if (algo !== 'pbkdf2') return false;
  const iterations = parseInt(iterStr, 10);
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64urlDecode(saltB), iterations, hash: 'SHA-256' }, key, 256),
  );
  const expected = b64urlDecode(hashB);
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

/** 从 Cookie 或 Bearer 取会话，校验角色 */
export async function requireAuth(req: Request, env: Env, role?: 'admin'): Promise<any> {
  const token = getCookie(req, 'sid') || (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!token) throw new HttpError(401, '未登录');
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (role === 'admin' && payload.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  return payload;
}

export { cookie };
