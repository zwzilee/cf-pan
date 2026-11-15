import type { Env } from './types';
import { b64url, b64urlDecode, HttpError } from './util';

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export interface ShareClaims {
  f: string; // file id
  e: number; // 过期时间（unix 秒）
  j: string; // 分享 id（短码），用于吊销
  d?: number; // 最多下载次数（不填=不限）
}

interface ShareRecord {
  fileId: string;
  max: number;
  used: number;
  exp?: number;
}

/* 短码字母表：去掉了容易看错的 0/O/1/l/I */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';

/** 8 位随机短码（≈45 bit 熵） */
function shortId(len = 8): string {
  const b = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

/**
 * 签发分享链接：8 位短码 + KV 记录（不把文件 id / 过期时间放进 URL）。
 * 短码本身就是凭证，KV 里存 fileId / 过期 / 下载次数，撤销 = 删掉这条。
 * 老的长链接（base64url.签名）仍然认，见 verifyShareToken 的兼容分支。
 */
export async function createShareToken(
  env: Env,
  fileId: string,
  ttlSec: number,
  maxDownloads?: number,
): Promise<{ token: string; jti: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const ttl = Math.max(60, ttlSec);
  const rec: ShareRecord = {
    fileId,
    max: maxDownloads && maxDownloads > 0 ? maxDownloads : 0,
    used: 0,
    exp,
  };
  let id = '';
  for (let i = 0; i < 6; i++) {
    const cand = shortId(8);
    if (!(await env.KV.get('share:' + cand))) {
      id = cand;
      break;
    }
  }
  if (!id) throw new HttpError(500, '生成短码失败，请重试');
  await env.KV.put('share:' + id, JSON.stringify(rec), { expirationTtl: ttl });
  return { token: id, jti: id, exp };
}

export async function verifyShareToken(env: Env, token: string): Promise<ShareClaims> {
  const raw = String(token || '').trim();

  // 兼容旧的长链接：<base64url(claims)>.<base64url(sig)>
  if (raw.includes('.')) {
    const dot = raw.lastIndexOf('.');
    if (dot < 1) throw new HttpError(400, '分享链接格式不对');
    const body = raw.slice(0, dot);
    const sig = b64urlDecode(raw.slice(dot + 1));
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.JWT_SECRET), sig, enc.encode(body));
    if (!ok) throw new HttpError(403, '分享链接签名无效');
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as ShareClaims;
    if (!claims.f || !claims.e || !claims.j) throw new HttpError(400, '分享链接内容不完整');
    if (Date.now() / 1000 > claims.e) throw new HttpError(410, '分享链接已过期');
    return claims;
  }

  // 新短码
  if (!/^[0-9A-Za-z]{4,24}$/.test(raw)) throw new HttpError(400, '分享链接格式不对');
  const stored = await env.KV.get('share:' + raw);
  if (!stored) throw new HttpError(404, '分享链接不存在或已被撤销');
  const rec = JSON.parse(stored) as ShareRecord;
  const exp = Number(rec.exp || 0);
  if (exp && Date.now() / 1000 > exp) throw new HttpError(410, '分享链接已过期');
  return { f: rec.fileId, e: exp, j: raw, d: rec.max > 0 ? rec.max : undefined };
}

/** 吊销检查；countIt=true 时占用一次下载额度（视频拖动进度条不算） */
export async function checkShareUsable(env: Env, claims: ShareClaims, countIt: boolean): Promise<ShareRecord> {
  const raw = await env.KV.get('share:' + claims.j);
  if (!raw) throw new HttpError(410, '分享链接已被撤销');
  const rec = JSON.parse(raw) as ShareRecord;
  if (rec.max > 0 && rec.used >= rec.max) throw new HttpError(410, '分享链接下载次数已用完');

  if (countIt) {
    rec.used += 1;
    const left = claims.e - Math.floor(Date.now() / 1000);
    await env.KV.put('share:' + claims.j, JSON.stringify(rec), {
      expirationTtl: Math.max(60, left),
    });
  }
  return rec;
}

export async function revokeShare(env: Env, jti: string): Promise<boolean> {
  const existed = await env.KV.get('share:' + jti);
  if (!existed) return false;
  await env.KV.delete('share:' + jti);
  return true;
}
