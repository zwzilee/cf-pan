import { b64url, b64urlDecode } from './util';

const enc = new TextEncoder();

async function keyFrom(master: string): Promise<CryptoKey> {
  const kh = await crypto.subtle.digest('SHA-256', enc.encode(master));
  return crypto.subtle.importKey('raw', kh, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * 加密账号 secret。配置了 MASTER_KEY -> AES-GCM 密文(enc:iv:ct)；
 * 否则退化为 plain:base64（仅本地开发用，生产一定配 MASTER_KEY）。
 */
export async function encryptSecret(master: string | undefined, plain: string): Promise<string> {
  if (!master) return 'plain:' + btoa(plain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(master), enc.encode(plain)),
  );
  return 'enc:' + b64url(iv) + ':' + b64url(ct);
}

export async function decryptSecret(master: string | undefined, stored: string): Promise<string> {
  if (!stored.startsWith('enc:')) {
    return stored.startsWith('plain:') ? atob(stored.slice(6)) : stored;
  }
  if (!master) throw new Error('数据库里是加密的账号密钥，但未配置 MASTER_KEY');
  const [, ivb, ctb] = stored.split(':');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(ivb) },
    await keyFrom(master),
    b64urlDecode(ctb),
  );
  return new TextDecoder().decode(pt);
}
