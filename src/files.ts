import type { Env } from './types';
import * as store from './store';
import * as s3 from './s3';

export interface DeleteResult {
  removed: number;
  blobsDeleted: number;
}

/**
 * 真删一个文件：分片按 blob 引用计数回收，配额按账号退还。
 * 管理后台的 DELETE /api/files/:id 和 WebDAV 的 DELETE 都走这里。
 */
export async function deleteFileDeep(env: Env, fileId: string): Promise<DeleteResult> {
  const { results: chunks } = await env.DB.prepare('SELECT * FROM chunks WHERE file_id = ?').bind(fileId).all<any>();
  const accounts = await store.listAccounts(env);
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // 先把每片的引用数减掉，收集归零的（同一份内容被别的文件共用时不能删）
  const toDelete = new Set<string>();
  for (const c of chunks) {
    if (!c.hash) {
      // 老数据（去重上线前传的）：没有 hash，直接按 object_key 删
      const acct = byId.get(c.account_id);
      if (acct) {
        try {
          await s3.s3Delete(acct, c.object_key);
        } catch {
          /* 单个分片删除失败不阻断，最多留垃圾 */
        }
        await store.reserveBytes(env, c.account_id, -c.size);
      }
      continue;
    }
    const b = await env.DB.prepare('SELECT * FROM blobs WHERE hash = ?').bind(c.hash).first<any>();
    if (!b) continue;
    const left = (b.refs || 1) - 1;
    if (left > 0) {
      await env.DB.prepare('UPDATE blobs SET refs = ? WHERE hash = ?').bind(left, c.hash).run();
    } else {
      toDelete.add(c.hash);
    }
  }

  for (const hash of toDelete) {
    const b = await env.DB.prepare('SELECT * FROM blobs WHERE hash = ?').bind(hash).first<any>();
    if (!b) continue;
    const acct = byId.get(b.account_id);
    if (acct) {
      try {
        await s3.s3Delete(acct, b.object_key);
      } catch {
        /* 同上：失败留垃圾，下一次清理再试 */
      }
      await store.reserveBytes(env, b.account_id, -b.size);
    }
    await env.DB.prepare('DELETE FROM blobs WHERE hash = ?').bind(hash).run();
  }

  // 缩略图存在 KV 里，不在 D1 —— 不清掉会变成看不见的残留（文件都删了还能 GET 到图）
  try { await env.KV.delete('thumb:' + fileId); } catch { /* KV 抽风不影响主流程 */ }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(fileId),
    env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId),
  ]);
  return { removed: chunks.length, blobsDeleted: toDelete.size };
}
