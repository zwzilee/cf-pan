import { AwsClient } from 'aws4fetch';
import type { Account } from './types';

/**
 * 跨账号访问 R2：Worker 的 R2 binding 只能读「同一个账号」，所以池子里
 * 别的账号必须走 S3 兼容 API（aws4fetch 签名）。endpoint 形如：
 *   https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>
 */

const clients = new Map<string, AwsClient>();

function clientFor(a: Account): AwsClient {
  let c = clients.get(a.access_key_id);
  if (!c) {
    c = new AwsClient({
      accessKeyId: a.access_key_id,
      secretAccessKey: a.secret_access_key,
      service: 's3',
      region: 'auto',
    });
    clients.set(a.access_key_id, c);
  }
  return c;
}

function objectUrl(a: Account, key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `https://${a.account_id}.r2.cloudflarestorage.com/${a.bucket}/${encoded}`;
}

export async function s3Put(a: Account, key: string, body: ArrayBuffer): Promise<{ etag: string }> {
  const res = await clientFor(a).fetch(objectUrl(a, key), {
    method: 'PUT',
    body,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${await res.text()}`);
  return { etag: res.headers.get('ETag') || '' };
}

export async function s3Get(a: Account, key: string, range?: [number, number]): Promise<Response> {
  const headers: Record<string, string> = {};
  if (range) headers['Range'] = `bytes=${range[0]}-${range[1]}`;
  const res = await clientFor(a).fetch(objectUrl(a, key), { method: 'GET', headers });
  if (!res.ok && res.status !== 206) throw new Error(`S3 GET ${res.status}`);
  return res;
}

export async function s3Delete(a: Account, key: string): Promise<void> {
  const res = await clientFor(a).fetch(objectUrl(a, key), { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`S3 DELETE ${res.status}`);
}

/** 连通性自检：HEAD 一下桶 */
export async function s3HeadBucket(a: Account): Promise<boolean> {
  const res = await clientFor(a).fetch(`https://${a.account_id}.r2.cloudflarestorage.com/${a.bucket}`, {
    method: 'HEAD',
  });
  return res.ok;
}
