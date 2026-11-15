import type { Account, ChunkRow, Env } from './types';
import * as s3 from './s3';
import * as store from './store';
import { nowISO } from './util';

export const DEFAULT_CHUNK = 16 * 1024 * 1024; // 16MB
export const MIN_CHUNK = 5 * 1024 * 1024; // 5MB
export const MAX_CHUNK = 100 * 1024 * 1024; // 100MB

export interface InitArgs {
  name: string;
  folderId?: number | null;
  size: number;
  chunkSize?: number;
}

/** 第一步：建上传会话，告诉前端要切几片 */
export async function initUpload(env: Env, args: InitArgs) {
  const cs = Math.min(Math.max(args.chunkSize || DEFAULT_CHUNK, MIN_CHUNK), MAX_CHUNK);
  const count = Math.max(1, Math.ceil(args.size / cs));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO uploads (id, name, folder_id, size, chunk_size, chunks_count, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?)`,
  )
    .bind(id, args.name, args.folderId ?? null, args.size, cs, count, nowISO())
    .run();
  return { uploadId: id, chunkSize: cs, chunksCount: count };
}

/** 第二步：逐片上传。每片挑一个最空的账号落盘，幂等可续传 */
export async function putChunk(env: Env, uploadId: string, idx: number, body: ArrayBuffer) {
  const up = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first<any>();
  if (!up) throw new Error('上传会话不存在或已完成');
  if (idx < 0 || idx >= up.chunks_count) throw new Error(`分片越界: ${idx}/${up.chunks_count}`);

  const exist = await env.DB.prepare('SELECT id, etag FROM chunks WHERE file_id = ? AND idx = ?')
    .bind(uploadId, idx)
    .first<any>();
  if (exist) return { ok: true, skipped: true, etag: exist.etag };

  const accounts = await store.listAccounts(env, true);
  const acct = store.pickAccount(accounts);
  const objectKey = `u/${uploadId}/${idx}`;

  await store.reserveBytes(env, acct.id, body.byteLength); // 先占额
  let etag = '';
  try {
    ({ etag } = await s3.s3Put(acct, objectKey, body));
  } catch (e) {
    await store.reserveBytes(env, acct.id, -body.byteLength); // 回滚
    throw e;
  }

  await env.DB.prepare(
    'INSERT INTO chunks (file_id, idx, account_id, bucket, object_key, size, etag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(uploadId, idx, acct.id, acct.bucket, objectKey, body.byteLength, etag, nowISO())
    .run();

  return { ok: true, account: acct.name, etag };
}

/** 第三步：所有分片到齐后落元数据 */
export async function completeUpload(env: Env, uploadId: string) {
  const up = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first<any>();
  if (!up) throw new Error('上传会话不存在');

  const { results: chunks } = await env.DB.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY idx')
    .bind(uploadId)
    .all<any>();
  if (chunks.length !== up.chunks_count) {
    throw new Error(`分片不完整：${chunks.length}/${up.chunks_count}`);
  }
  const total = chunks.reduce((s: number, c: any) => s + c.size, 0);
  if (total !== up.size) throw new Error(`文件大小不符：分片合计 ${total} != ${up.size}`);

  const fileId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO files (id, name, folder_id, size, chunk_size, chunks_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`,
    ).bind(fileId, up.name, up.folder_id, up.size, up.chunk_size, up.chunks_count, nowISO()),
    env.DB.prepare('UPDATE chunks SET file_id = ? WHERE file_id = ?').bind(fileId, uploadId),
    env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(uploadId),
  ]);
  return { fileId };
}

export async function getChunks(env: Env, fileId: string): Promise<ChunkRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY idx')
    .bind(fileId)
    .all<ChunkRow>();
  return results;
}

interface PlannedPart {
  chunk: ChunkRow;
  localStart: number;
  localEnd: number;
}

/** 把一次 [start,end] 请求映射到「哪几片、每片取哪段」 */
export function planRanges(chunks: ChunkRow[], start: number, end: number): PlannedPart[] {
  const out: PlannedPart[] = [];
  let off = 0;
  for (const c of chunks) {
    const cStart = off;
    const cEnd = off + c.size - 1;
    off += c.size;
    if (cEnd < start) continue;
    if (cStart > end) break;
    out.push({
      chunk: c,
      localStart: Math.max(0, start - cStart),
      localEnd: Math.min(c.size - 1, end - cStart),
    });
  }
  return out;
}

/**
 * 单个下载请求最多拼多少片。Cloudflare Workers 免费版每请求只有
 * 50 个外部子请求（每个分片 GET 算 1 个），付费版默认 10000 可调。
 * 超了就前端按 Range 分段续拉（见 web/index.html 的 downloadFile）。
 */
export const MAX_PARTS_PER_REQUEST = 50;

/** 给定 start，返回本次请求最多能覆盖到哪个字节（含），用于服务端夹断 */
export function maxEndForRequest(chunks: ChunkRow[], start: number, maxParts = MAX_PARTS_PER_REQUEST): number {
  let off = 0;
  let count = 0;
  for (const c of chunks) {
    const cStart = off;
    const cEnd = off + c.size - 1;
    off += c.size;
    if (cEnd < start) continue;
    count++;
    if (count >= maxParts) return cEnd;
  }
  return off - 1;
}

/** 把多账号上的分片拼成一条流；Range 请求只回必要的几段 */
export async function streamDownload(env: Env, fileId: string, start: number, end: number, preloaded?: ChunkRow[]): Promise<ReadableStream> {
  const chunks = preloaded ?? (await getChunks(env, fileId));
  const accounts = await store.listAccounts(env);
  const byId = new Map<number, Account>(accounts.map((a) => [a.id, a]));
  const parts = planRanges(chunks, start, end);

  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      const part = parts[i++];
      const acct = byId.get(part.chunk.account_id);
      if (!acct) {
        controller.error(new Error(`分片 #${part.chunk.idx} 所在账号已删除`));
        return;
      }
      try {
        const res = await s3.s3Get(acct, part.chunk.object_key, [part.localStart, part.localEnd]);
        controller.enqueue(new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
