import type { Account, ChunkRow, Env } from './types';
import * as s3 from './s3';
import * as store from './store';
import { releaseChunks } from './files';
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
export async function initUpload(env: Env, args: InitArgs & { enc?: number; encMeta?: string | null; src?: string | null }) {
  const cs = Math.min(Math.max(args.chunkSize || DEFAULT_CHUNK, MIN_CHUNK), MAX_CHUNK);
  const count = Math.max(1, Math.ceil(args.size / cs));
  const id = crypto.randomUUID();
  const nowIso = nowISO();
  await env.DB.prepare(
    `INSERT INTO uploads (id, name, folder_id, size, chunk_size, chunks_count, status, created_at, enc, enc_meta)
     VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
  )
    .bind(id, args.name, args.folderId ?? null, args.size, cs, count, nowIso, args.enc ? 1 : 0, args.encMeta || null)
    .run();
  // 面板直传的来源记一条「进行中」历史；完成时由 completeUpload 翻成 done。
  await ensureUploadHistory(env, id, args.name, args.size, args.folderId ?? null, (args.src || 'panel')).catch(() => {});
  return { uploadId: id, chunkSize: cs, chunksCount: count };
}

/** 面板/接口直传的独立历史表（与 TG 的 tg_jobs 分开，统一在「上传历史」页合并展示）。 */
export async function ensureUploadHistory(env: Env, uploadId: string, name: string, size: number, folderId: number | null, src: string) {
  const now = nowISO();
  await env.DB.prepare(
    `INSERT INTO upload_history (upload_id, name, size, folder_id, src, phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?)
     ON CONFLICT(upload_id) DO NOTHING`,
  ).bind(uploadId, name, size, folderId, src, now, now).run();
}

export async function updateUploadHistory(env: Env, uploadId: string, patch: { phase?: string; error?: string | null; file_id?: string | null }) {
  const cols: string[] = [];
  const vals: any[] = [];
  if (patch.phase !== undefined) { cols.push('phase = ?'); vals.push(patch.phase); }
  if (patch.error !== undefined) { cols.push('error = ?'); vals.push(patch.error); }
  if (patch.file_id !== undefined) { cols.push('file_id = ?'); vals.push(patch.file_id); }
  if (!cols.length) return;
  cols.push('updated_at = ?'); vals.push(nowISO());
  vals.push(uploadId);
  await env.DB.prepare(`UPDATE upload_history SET ${cols.join(', ')} WHERE upload_id = ?`).bind(...vals).run().catch(() => {});
}

/** sha256(内容) 的十六进制，内容寻址的主键 */
export async function sha256hex(body: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', body);
  return Array.from(new Uint8Array(d))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 第二步：逐片上传。每片挑一个最空的账号落盘，幂等可续传。
 *
 * 内容寻址去重：先算 sha256，如果 blobs 里已经有这一片（同一份内容以前传过），
 * 就不写 R2，只把 chunks 指向已有的对象并给 refs +1 —— 存 100 份同一部电影只占一份空间。
 */
export async function putChunk(env: Env, uploadId: string, idx: number, body: ArrayBuffer) {
  const up = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first<any>();
  if (!up) return { ok: true, skipped: 'session-gone' }; // 会话已完成（并发重复批次），静默跳过
  if (idx < 0 || idx >= up.chunks_count) throw new Error(`分片越界: ${idx}/${up.chunks_count}`);

  const exist = await env.DB.prepare('SELECT id, etag FROM chunks WHERE file_id = ? AND idx = ?')
    .bind(uploadId, idx)
    .first<any>();
  if (exist) return { ok: true, skipped: true, etag: exist.etag };

  const hash = await sha256hex(body);
  const size = body.byteLength;

  // ① 命中已有内容 → 只加引用，不占新空间
  const hit = await env.DB.prepare('SELECT * FROM blobs WHERE hash = ? AND size = ?').bind(hash, size).first<any>();
  if (hit) {
    await env.DB.batch([
      env.DB.prepare('UPDATE blobs SET refs = refs + 1 WHERE hash = ?').bind(hash),
      env.DB.prepare(
        'INSERT INTO chunks (file_id, idx, hash, account_id, bucket, object_key, size, etag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(uploadId, idx, hash, hit.account_id, hit.bucket, hit.object_key, size, hit.etag, nowISO()),
    ]);
    return { ok: true, dedup: true, hash, saved: size, etag: hit.etag };
  }

  // ② 没命中 → 正常落盘
  const accounts = await store.listAccounts(env, true);
  const acct = store.pickAccount(accounts);
  const objectKey = `b/${hash.slice(0, 2)}/${hash}`;

  await store.reserveBytes(env, acct.id, size); // 先占额
  let etag = '';
  try {
    ({ etag } = await s3.s3Put(acct, objectKey, body));
  } catch (e) {
    await store.reserveBytes(env, acct.id, -size); // 回滚
    throw e;
  }

  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO blobs (hash, size, account_id, bucket, object_key, etag, refs, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    ).bind(hash, size, acct.id, acct.bucket, objectKey, etag, nowISO()),
    env.DB.prepare(
      'INSERT INTO chunks (file_id, idx, hash, account_id, bucket, object_key, size, etag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(uploadId, idx, hash, acct.id, acct.bucket, objectKey, size, etag, nowISO()),
  ]);

  return { ok: true, account: acct.name, hash, etag };
}

/**
 * 中途放弃：把已经传上去的分片释放掉（引用计数回收 + 退配额），再删掉会话。
 * 没有这一步的话，用户取消上传后那些分片会一直占着额度，而面板里根本看不到它们。
 */
export async function abortUpload(env: Env, uploadId: string) {
  const up = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first<any>();
  if (!up) throw new Error('上传会话不存在或已完成');
  // ★ 竞态兜底：complete 已经把成品写进 files、却因并发/中断没删掉这条 upload 会话时，
  //   这里绝不能当成「取消上传」把它删掉重算 —— 否则会出现「文件已在盘上、会话却挂僵尸」的两头不一致。
  //   识别方法：同名同大小、且已 ready 的成品存在 → 只做对账收尾（删残留会话 + 补历史 done），不释放分片引用。
  const ready = await env.DB.prepare(
    "SELECT id FROM files WHERE name = ? AND size = ? AND status = 'ready' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
  ).bind(up.name, up.size).first<any>().catch(() => null);
  if (ready?.id) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(uploadId),
      env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(uploadId),
    ]).catch(() => {});
    await updateUploadHistory(env, uploadId, { phase: 'done', file_id: String(ready.id), error: null }).catch(() => {});
    return { ok: true, reconciled: true, fileId: String(ready.id) };
  }
  const r = await releaseChunks(env, uploadId);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(uploadId),
    env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(uploadId),
  ]);
  return { ok: true, ...r };
}

/** 第三步：所有分片到齐后落元数据（整文件 sha256 = 各片 hash 再喂一遍） */
export async function completeUpload(env: Env, uploadId: string) {
  const up = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(uploadId).first<any>();
  if (!up) {
    // 会话已不在（并发批次已完成 / upload 被删），但成品可能已落库：按上传历史找回名/大小再核对。
    const h = await env.DB.prepare('SELECT name, size FROM upload_history WHERE upload_id = ?').bind(uploadId).first<any>().catch(() => null);
    if (h?.name) {
      const f = await env.DB.prepare(
        "SELECT id FROM files WHERE name = ? AND size = ? AND status = 'ready' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
      ).bind(h.name, h.size).first<any>().catch(() => null);
      if (f?.id) { await updateUploadHistory(env, uploadId, { phase: 'done', file_id: String(f.id), error: null }).catch(() => {}); return { fileId: String(f.id) }; }
    }
    throw new Error('上传会话不存在');
  }

  const { results: chunks } = await env.DB.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY idx')
    .bind(uploadId)
    .all<any>();
  if (chunks.length !== up.chunks_count) {
    throw new Error(`分片不完整：${chunks.length}/${up.chunks_count}`);
  }
  const total = chunks.reduce((s: number, c: any) => s + c.size, 0);
  if (total !== up.size) throw new Error(`文件大小不符：分片合计 ${total} != ${up.size}`);

  let fileHash: string | null = null;
  if (chunks.every((c: any) => typeof c.hash === 'string' && /^[0-9a-f]{64}$/.test(c.hash))) {
    const joined = new TextEncoder().encode(chunks.map((c: any) => c.hash).join(''));
    fileHash = await sha256hex(joined.buffer as ArrayBuffer);
  }

  const fileId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO files (id, name, folder_id, size, chunk_size, chunks_count, status, sha256, created_at, enc, enc_meta)
       VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
    ).bind(fileId, up.name, up.folder_id, up.size, up.chunk_size, up.chunks_count, fileHash, nowISO(), up.enc || 0, up.enc_meta || null),
    env.DB.prepare('UPDATE chunks SET file_id = ? WHERE file_id = ?').bind(fileId, uploadId),
    env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(uploadId),
  ]);
  await updateUploadHistory(env, uploadId, { phase: 'done', file_id: fileId, error: null }).catch(() => {});
  return { fileId, sha256: fileHash };
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
export const MAX_PARTS_PER_REQUEST = 400;

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

/**
 * 单条流同时挂多少个 R2 分片 GET。串行取片会让播放器「等一片、拿一片」，
 * 25MB 分片 × 网络延迟 = 必然黑屏卡顿；这里用滑动窗口并发预取，
 * 但按分片顺序冲刷，保证字节连续。
 */
export const STREAM_PREFETCH = 6;

/** 把多账号上的分片拼成一条流；Range 请求只回必要的几段（滑动窗口并发取片） */
export async function streamDownload(env: Env, fileId: string, start: number, end: number, preloaded?: ChunkRow[]): Promise<ReadableStream> {
  const chunks = preloaded ?? (await getChunks(env, fileId));
  const accounts = await store.listAccounts(env);
  const byId = new Map<number, Account>(accounts.map((a) => [a.id, a]));
  const parts = planRanges(chunks, start, end);

  const inflight: Promise<Uint8Array>[] = [];
  let next = 0;
  let failed = false;

  // 把一个分片 GET 包成带重试的 promise。R2 的 S3 端点在大 Range 上偶发
  // ECONNRESET —— 播放器读 MP4 尾部 moov 时只要断一次就整条 SourceBuffer 报废，
  // 表现为黑屏、readyState 归零、error=4，所以这里必须重试而不是直接抛。
  const fetchPart = async (part: PlannedPart, acct: Account): Promise<Uint8Array> => {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await s3.s3Get(acct, part.chunk.object_key, [part.localStart, part.localEnd]);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        lastErr = e;
        if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 220));
      }
    }
    throw new Error(`分片 #${part.chunk.idx} 读取失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  };

  const startOne = (): void => {
    const part = parts[next++];
    const acct = byId.get(part.chunk.account_id);
    if (!acct) {
      inflight.push(Promise.reject(new Error(`分片 #${part.chunk.idx} 所在账号已删除`)));
      return;
    }
    inflight.push(fetchPart(part, acct));
  };

  const fill = (): void => {
    while (!failed && next < parts.length && inflight.length < STREAM_PREFETCH) startOne();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        fill();
        if (!inflight.length) {
          controller.close();
          return;
        }
        const head = inflight.shift()!;
        const buf = await head;
        controller.enqueue(buf);
        fill();
      } catch (e) {
        failed = true;
        controller.error(e);
      }
    },
    cancel() {
      failed = true;
    },
  });
}
