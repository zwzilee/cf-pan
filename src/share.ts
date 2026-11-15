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
  j: string; // jti，用于吊销
  d?: number; // 最多下载次数（不填=不限）
}

interface ShareRecord {
  fileId: string;
  max: number;
  used: number;
}

/**
 * 签发分享链接：HMAC-SHA256 签名，claims 里带过期时间 + jti。
 * 同时在 KV 里放一条记录，用于「撤销」和「下载次数上限」。
 * 纯签名是无状态的，但无状态就没法撤销 —— 所以这里用 KV 做吊销名单。
 */
export async function createShareToken(
  env: Env,
  fileId: string,
  ttlSec: number,
  maxDownloads?: number,
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const claims: ShareClaims = { f: fileId, e: exp, j: jti };
  if (maxDownloads && maxDownloads > 0) claims.d = maxDownloads;

  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env.JWT_SECRET), enc.encode(body)));
  const token = `${body}.${b64url(sig)}`;

  const rec: ShareRecord = { fileId, max: maxDownloads && maxDownloads > 0 ? maxDownloads : 0, used: 0 };
  await env.KV.put('share:' + jti, JSON.stringify(rec), { expirationTtl: Math.max(60, ttlSec) });

  return { token, jti, exp };
}

export async function verifyShareToken(env: Env, token: string): Promise<ShareClaims> {
  const dot = token.lastIndexOf('.');
  if (dot < 1) throw new HttpError(400, '分享链接格式不对');
  const body = token.slice(0, dot);
  const sig = b64urlDecode(token.slice(dot + 1));

  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.JWT_SECRET), sig, enc.encode(body));
  if (!ok) throw new HttpError(403, '分享链接签名无效');

  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as ShareClaims;
  if (!claims.f || !claims.e || !claims.j) throw new HttpError(400, '分享链接内容不完整');
  if (Date.now() / 1000 > claims.e) throw new HttpError(410, '分享链接已过期');
  return claims;
}

/** 吊销检查；countIt=true 时占用一次下载额度（视频拖动进度条不算） */
export async function checkShareUsable(env: Env, claims: ShareClaims, countIt: boolean): Promise<ShareRecord> {
  const raw = await env.KV.get('share:' + claims.j);
  if (!raw) throw new HttpError(410, '分享链接已被撤销');
  const rec = JSON.parse(raw) as ShareRecord;
  if (rec.max > 0 && rec.used >= rec.max) throw new HttpError(410, '分享链接下载次数已用完');

  if (countIt) {
    rec.used += 1;
    await env.KV.put('share:' + claims.j, JSON.stringify(rec), {
      expirationTtl: Math.max(60, claims.e - Math.floor(Date.now() / 1000)),
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
