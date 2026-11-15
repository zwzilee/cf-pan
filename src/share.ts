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

export interface ShareRecord {
  fileId: string;
  max: number; // 总下载次数上限，0=不限
  used: number; // 已用总次数
  exp?: number;
  code?: string; // 提取码（4-8 位，空=不需要）
  dayMax?: number; // 每天最多下载次数，0=不限
  dayKey?: string; // 当天日期 yyyy-mm-dd
  dayUsed?: number; // 当天已用次数
  byteMax?: number; // 每天流量上限（字节），0=不限
  dayBytes?: number; // 当天已用流量
  note?: string; // 备注（给管理员看）
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function rollDay(rec: ShareRecord): void {
  const d = today();
  if (rec.dayKey !== d) {
    rec.dayKey = d;
    rec.dayUsed = 0;
    rec.dayBytes = 0;
  }
}

export interface CreateOpts {
  ttlSec: number;
  maxDownloads?: number;
  code?: string;
  dailyMax?: number;
  dailyBytes?: number;
  note?: string;
}

/**
 * 签发分享链接：8 位短码 + KV 记录（不把文件 id / 过期时间放进 URL）。
 * 短码本身就是凭证，KV 里存 fileId / 过期 / 次数 / 提取码 / 每日配额，撤销 = 删掉这条。
 * 老的长链接（base64url.签名）仍然认，见 verifyShareToken 的兼容分支。
 */
export async function createShareToken(
  env: Env,
  fileId: string,
  ttlSec: number,
  maxDownloads?: number,
  opts: Partial<CreateOpts> = {},
): Promise<{ token: string; jti: string; exp: number; code: string }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const ttl = Math.max(60, ttlSec);
  const code = String(opts.code || '').trim().slice(0, 16);
  const rec: ShareRecord = {
    fileId,
    max: maxDownloads && maxDownloads > 0 ? maxDownloads : 0,
    used: 0,
    exp,
    code: code || undefined,
    dayMax: opts.dailyMax && opts.dailyMax > 0 ? Math.floor(opts.dailyMax) : 0,
    byteMax: opts.dailyBytes && opts.dailyBytes > 0 ? Math.floor(opts.dailyBytes) : 0,
    dayKey: today(),
    dayUsed: 0,
    dayBytes: 0,
    note: opts.note ? String(opts.note).slice(0, 60) : undefined,
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
  return { token: id, jti: id, exp, code };
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

export async function getShareRecord(env: Env, jti: string): Promise<ShareRecord | null> {
  const raw = await env.KV.get('share:' + jti);
  return raw ? (JSON.parse(raw) as ShareRecord) : null;
}

export function needsCode(rec: ShareRecord | null): boolean {
  return !!(rec && rec.code);
}

/** 提取码校验（大小写不敏感） */
export function checkCode(rec: ShareRecord, given?: string | null): void {
  if (!rec.code) return;
  const g = String(given || '').trim();
  if (!g) throw new HttpError(401, '需要提取码');
  if (g.toLowerCase() !== rec.code.toLowerCase()) throw new HttpError(403, '提取码不对');
}

/**
 * 吊销检查；countIt=true 时占用一次下载额度（视频拖动进度条不算）。
 * bytes = 本次会传输的字节数，用于每日流量配额。
 */
export async function checkShareUsable(
  env: Env,
  claims: ShareClaims,
  countIt: boolean,
  bytes = 0,
  code?: string | null,
): Promise<ShareRecord> {
  const raw = await env.KV.get('share:' + claims.j);
  if (!raw) throw new HttpError(410, '分享链接已被撤销');
  const rec = JSON.parse(raw) as ShareRecord;
  rollDay(rec);
  checkCode(rec, code);
  if (rec.max > 0 && rec.used >= rec.max) throw new HttpError(410, '分享链接下载次数已用完');
  if (rec.dayMax && (rec.dayUsed || 0) >= rec.dayMax) throw new HttpError(429, `今天的下载次数用完了（每天 ${rec.dayMax} 次）`);
  if (rec.byteMax && (rec.dayBytes || 0) + bytes > rec.byteMax) {
    throw new HttpError(429, `今天的流量用完了（每天 ${(rec.byteMax / 1048576).toFixed(0)} MB）`);
  }

  if (countIt) {
    rec.used += 1;
    rec.dayUsed = (rec.dayUsed || 0) + 1;
    rec.dayBytes = (rec.dayBytes || 0) + bytes;
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

/** 更新分享设置（提取码 / 每日配额 / 备注），不动已用计数 */
export async function updateShare(
  env: Env,
  jti: string,
  patch: { code?: string | null; dailyMax?: number; dailyBytes?: number; note?: string; maxDownloads?: number },
): Promise<ShareRecord> {
  const raw = await env.KV.get('share:' + jti);
  if (!raw) throw new HttpError(404, '分享不存在或已过期');
  const rec = JSON.parse(raw) as ShareRecord;
  if (patch.code !== undefined) rec.code = patch.code ? String(patch.code).slice(0, 16) : undefined;
  if (patch.dailyMax !== undefined) rec.dayMax = Math.max(0, Math.floor(patch.dailyMax));
  if (patch.dailyBytes !== undefined) rec.byteMax = Math.max(0, Math.floor(patch.dailyBytes));
  if (patch.note !== undefined) rec.note = String(patch.note).slice(0, 60);
  if (patch.maxDownloads !== undefined) rec.max = Math.max(0, Math.floor(patch.maxDownloads));
  const left = Number(rec.exp || 0) - Math.floor(Date.now() / 1000);
  await env.KV.put('share:' + jti, JSON.stringify(rec), { expirationTtl: Math.max(60, left) });
  return rec;
}
