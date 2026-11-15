/**
 * 扩展功能：回收站、标签、收藏、最近访问、搜索、批量操作、移动、缩略图、打包下载
 * 依赖：roles（鉴权）、util（json/HttpError/nowISO）、files（deleteFileDeep）、chunk（streamDownload）
 */
import { requireAdmin, requireAny } from './roles';
import { HttpError, json, nowISO } from './util';
import { deleteFileDeep } from './files';
import { streamDownload, initUpload, putChunk, completeUpload } from './chunk';

type Ctx = { uid: number; name?: string };

async function who(req: Request, env: any): Promise<Ctx> {
  const a: any = await requireAny(req, env);
  return { uid: Number(a.uid ?? 0), name: a.name };
}

function q(url: URL, k: string): string {
  return (url.searchParams.get(k) || '').trim();
}

/* ============================ 回收站 ============================ */

/** 软删：把文件/目录（含子树）标记 deleted_at */
export async function softDeleteFolder(env: any, rootId: number): Promise<{ folders: number; files: number }> {
  const ids: number[] = [rootId];
  for (let i = 0; i < ids.length; i++) {
    const { results } = await env.DB.prepare('SELECT id FROM folders WHERE parent_id = ?').bind(ids[i]).all();
    for (const r of results as any[]) ids.push(Number(r.id));
  }
  const now = nowISO();
  let files = 0;
  for (const id of ids) {
    const r = await env.DB.prepare('UPDATE folders SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now, id).run();
    const f = await env.DB.prepare('UPDATE files SET deleted_at = ? WHERE folder_id = ? AND deleted_at IS NULL').bind(now, id).run();
    files += Number((f as any).meta?.changes || 0);
    files += 0 * Number((r as any).meta?.changes || 0);
  }
  return { folders: ids.length, files };
}

export async function trashHandler(req: Request, env: any): Promise<Response> {
  await requireAdmin(req, env);
  const { results: fs } = await env.DB.prepare(
    "SELECT id,name,size,folder_id,created_at,deleted_at,'file' AS kind FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500",
  ).all();
  const { results: ds } = await env.DB.prepare(
    "SELECT id,name,'folder' AS kind,created_at,deleted_at FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500",
  ).all();
  return json({ files: fs, folders: ds });
}

export async function restoreHandler(req: Request, env: any): Promise<Response> {
  await requireAdmin(req, env);
  const b = await req.json<any>().catch(() => ({}));
  const kind = String(b.kind || '');
  const id = String(b.id || '');
  if (!id) throw new HttpError(400, '缺 id');
  if (kind === 'folder') {
    // 只还原「跟这次删除同一批」的东西：早先被单独删掉的，不该被顺带复活
    const rootRow = await env.DB.prepare('SELECT deleted_at FROM folders WHERE id = ?').bind(Number(id)).first();
    const stamp = rootRow ? rootRow.deleted_at : null;
    const ids: number[] = [Number(id)];
    for (let i = 0; i < ids.length; i++) {
      const { results } = await env.DB.prepare('SELECT id FROM folders WHERE parent_id = ?').bind(ids[i]).all();
      for (const r of results as any[]) ids.push(Number(r.id));
    }
    for (const x of ids) {
      await env.DB.prepare('UPDATE folders SET deleted_at = NULL WHERE id = ? AND deleted_at IS ?').bind(x, stamp).run();
      await env.DB.prepare('UPDATE files SET deleted_at = NULL WHERE folder_id = ? AND deleted_at IS ?').bind(x, stamp).run();
    }
    return json({ ok: true, folders: ids.length });
  }
  await env.DB.prepare('UPDATE files SET deleted_at = NULL WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

export async function purgeHandler(req: Request, env: any): Promise<Response> {
  await requireAdmin(req, env);
  const b = await req.json<any>().catch(() => ({}));
  if (b.all) {
    const { results: fs } = await env.DB.prepare('SELECT id FROM files WHERE deleted_at IS NOT NULL').all();
    let removed = 0;
    for (const f of fs as any[]) { await deleteFileDeep(env, String(f.id)); removed++; }
    // 目录倒序删
    const { results: ds } = await env.DB.prepare('SELECT id FROM folders WHERE deleted_at IS NOT NULL ORDER BY id DESC').all();
    for (const d of ds as any[]) await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(d.id).run();
    return json({ ok: true, files: removed, folders: (ds as any[]).length });
  }
  const kind = String(b.kind || 'file');
  const id = String(b.id || '');
  if (!id) throw new HttpError(400, '缺 id');
  if (kind === 'folder') {
    const ids: number[] = [Number(id)];
    for (let i = 0; i < ids.length; i++) {
      const { results } = await env.DB.prepare('SELECT id FROM folders WHERE parent_id = ?').bind(ids[i]).all();
      for (const r of results as any[]) ids.push(Number(r.id));
    }
    // 子树里还有活着的文件/子目录 —— 说明它们是被单独还原出来的，不能跟着一起销毁
    for (const x of ids) {
      const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id = ? AND deleted_at IS NULL').bind(x).first();
      if (Number((live as any)?.n || 0) > 0) {
        throw new HttpError(409, '这个目录里还有没删掉的文件，先把它们移走或删掉再来清理');
      }
      const liveSub = await env.DB.prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id = ? AND deleted_at IS NULL').bind(x).first();
      if (Number((liveSub as any)?.n || 0) > 0) {
        throw new HttpError(409, '这个目录里还有没删掉的子目录，先把它们移走或删掉再来清理');
      }
    }
    let files = 0;
    for (const x of ids) {
      const { results: fs } = await env.DB.prepare('SELECT id FROM files WHERE folder_id = ? AND deleted_at IS NOT NULL').bind(x).all();
      for (const f of fs as any[]) { await deleteFileDeep(env, String(f.id)); files++; }
    }
    for (let i = ids.length - 1; i >= 0; i--) await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(ids[i]).run();
    return json({ ok: true, files, folders: ids.length });
  }
  const r = await deleteFileDeep(env, id);
  return json({ ok: true, ...r });
}

/* ============================ 标签 ============================ */

export async function tagsHandler(req: Request, env: any): Promise<Response> {
  await requireAny(req, env);
  const { results } = await env.DB.prepare(
    'SELECT t.id,t.name,COUNT(ft.file_id) AS n FROM tags t LEFT JOIN file_tags ft ON ft.tag_id=t.id GROUP BY t.id ORDER BY t.name',
  ).all();
  return json({ tags: results });
}

export async function tagCreateHandler(req: Request, env: any): Promise<Response> {
  await requireAdmin(req, env);
  const b = await req.json<any>().catch(() => ({}));
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, '标签名不能为空');
  await env.DB.prepare('INSERT OR IGNORE INTO tags(name,created_at) VALUES(?,?)').bind(name, nowISO()).run();
  const row = await env.DB.prepare('SELECT id,name FROM tags WHERE name = ?').bind(name).first();
  return json({ ok: true, tag: row });
}

export async function tagDeleteHandler(req: Request, env: any, id: number): Promise<Response> {
  await requireAdmin(req, env);
  await env.DB.prepare('DELETE FROM file_tags WHERE tag_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/** 给文件打/去标签 */
export async function fileTagsHandler(req: Request, env: any, fileId: string): Promise<Response> {
  if (req.method === 'GET') {
    await requireAny(req, env);
    const { results } = await env.DB.prepare(
      'SELECT t.id,t.name FROM file_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id=? ORDER BY t.name',
    ).bind(fileId).all();
    return json({ tags: results });
  }
  await requireAdmin(req, env);
  const b = await req.json<any>().catch(() => ({}));
  const add = Array.isArray(b.add) ? b.add.map(Number) : [];
  const remove = Array.isArray(b.remove) ? b.remove.map(Number) : [];
  for (const t of add) await env.DB.prepare('INSERT OR IGNORE INTO file_tags(file_id,tag_id) VALUES(?,?)').bind(fileId, t).run();
  for (const t of remove) await env.DB.prepare('DELETE FROM file_tags WHERE file_id=? AND tag_id=?').bind(fileId, t).run();
  return json({ ok: true });
}

/* ============================ 收藏 / 最近 ============================ */

export async function starHandler(req: Request, env: any, fileId: string): Promise<Response> {
  const me = await who(req, env);
  if (req.method === 'DELETE') {
    await requireAdmin(req, env);
    await env.DB.prepare('DELETE FROM stars WHERE user_id=? AND file_id=?').bind(me.uid, fileId).run();
    return json({ ok: true, starred: false });
  }
  await requireAdmin(req, env);
  await env.DB.prepare('INSERT OR REPLACE INTO stars(user_id,file_id,created_at) VALUES(?,?,?)')
    .bind(me.uid, fileId, nowISO()).run();
  return json({ ok: true, starred: true });
}

export async function starListHandler(req: Request, env: any): Promise<Response> {
  const me = await who(req, env);
  const { results } = await env.DB.prepare(
    `SELECT f.id,f.name,f.size,f.chunks_count,f.folder_id,f.created_at,s.created_at AS starred_at
     FROM stars s JOIN files f ON f.id=s.file_id WHERE s.user_id=? AND f.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 500`,
  ).bind(me.uid).all();
  return json({ files: results });
}

export async function touchRecent(env: any, uid: number, fileId: string): Promise<void> {
  try {
    await env.DB.prepare('INSERT OR REPLACE INTO recent(user_id,file_id,at) VALUES(?,?,?)').bind(uid, fileId, nowISO()).run();
  } catch { /* 忽略 */ }
}

export async function recentHandler(req: Request, env: any): Promise<Response> {
  const me = await who(req, env);
  const { results } = await env.DB.prepare(
    `SELECT f.id,f.name,f.size,f.chunks_count,f.folder_id,f.created_at,r.at AS seen_at
     FROM recent r JOIN files f ON f.id=r.file_id WHERE r.user_id=? AND f.deleted_at IS NULL ORDER BY r.at DESC LIMIT 100`,
  ).bind(me.uid).all();
  return json({ files: results });
}

/* ============================ 搜索 ============================ */

export async function searchHandler(req: Request, env: any): Promise<Response> {
  await requireAny(req, env);
  const url = new URL(req.url);
  const term = q(url, 'q');
  if (!term) return json({ q: '', files: [], folders: [], docs: [], sheets: [] });
  const like = `%${term.replace(/[%_]/g, (m) => '\\' + m)}%`;
  const [fs, ds, dc, sh] = await Promise.all([
    env.DB.prepare("SELECT id,name,size,chunks_count,folder_id,created_at FROM files WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 50").bind(like).all(),
    env.DB.prepare("SELECT id,name,parent_id FROM folders WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 50").bind(like).all(),
    env.DB.prepare("SELECT id,name,folder_id,updated_at FROM docs WHERE name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 50").bind(like).all(),
    env.DB.prepare("SELECT id,name,folder_id,updated_at FROM sheets WHERE name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 50").bind(like).all(),
  ]);
  return json({ q: term, files: fs.results, folders: ds.results, docs: dc.results, sheets: sh.results });
}

/* ============================ 批量 / 移动 ============================ */

export async function batchHandler(req: Request, env: any): Promise<Response> {
  await requireAdmin(req, env);
  const b = await req.json<any>().catch(() => ({}));
  const op = String(b.op || '');
  const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
  if (!ids.length) throw new HttpError(400, '没选中东西');
  let n = 0;
  if (op === 'delete') {
    for (const id of ids) {
      const f = await env.DB.prepare('SELECT id FROM files WHERE id=?').bind(id).first();
      if (f) {
        await env.DB.prepare('UPDATE files SET deleted_at=? WHERE id=?').bind(nowISO(), id).run();
        n++;
      } else {
        await softDeleteFolder(env, Number(id));
        n++;
      }
    }
  } else if (op === 'move') {
    const target = b.folderId === null || b.folderId === '' ? null : Number(b.folderId);
    if (target !== null) {
      const t = await env.DB.prepare('SELECT id FROM folders WHERE id=? AND deleted_at IS NULL').bind(target).first();
      if (!t) throw new HttpError(404, '目标目录不存在');
    }
    for (const id of ids) {
      const f = await env.DB.prepare('SELECT id FROM files WHERE id=?').bind(id).first();
      if (f) { await env.DB.prepare('UPDATE files SET folder_id=? WHERE id=?').bind(target, id).run(); n++; }
      else {
        const fid = Number(id);
        if (target !== null) {
          if (fid === target) continue;
          // 禁止把目录移进它自己的子树（否则会变成环，页面再也进不去）
          let cur: number | null = target;
          let loop = false;
          for (let i = 0; i < 64 && cur !== null; i++) {
            if (cur === fid) { loop = true; break; }
            const row: any = await env.DB.prepare('SELECT parent_id FROM folders WHERE id=?').bind(cur).first();
            cur = row ? (row.parent_id === null ? null : Number(row.parent_id)) : null;
          }
          if (loop) throw new HttpError(400, '不能把目录移到它自己里面');
        }
        await env.DB.prepare('UPDATE folders SET parent_id=? WHERE id=?').bind(target, fid).run();
        n++;
      }
    }
  } else if (op === 'tag') {
    const tagId = Number(b.tagId || 0);
    if (!tagId) throw new HttpError(400, '缺标签');
    for (const id of ids) {
      const f = await env.DB.prepare('SELECT id FROM files WHERE id=?').bind(id).first();
      if (f) { await env.DB.prepare('INSERT OR IGNORE INTO file_tags(file_id,tag_id) VALUES(?,?)').bind(id, tagId).run(); n++; }
    }
  } else throw new HttpError(400, '不认识的批量操作');
  return json({ ok: true, op, n });
}

/** 单个移动（剪切/粘贴用） */
export async function moveHandler(req: Request, env: any): Promise<Response> {
  await requireAdmin(req, env);
  const b = await req.json<any>().catch(() => ({}));
  const kind = String(b.kind || 'file');
  const id = String(b.id || '');
  const target = b.folderId === null || b.folderId === undefined || b.folderId === '' ? null : Number(b.folderId);
  if (!id) throw new HttpError(400, '缺 id');
  if (target !== null) {
    const t = await env.DB.prepare('SELECT id FROM folders WHERE id=? AND deleted_at IS NULL').bind(target).first();
    if (!t) throw new HttpError(404, '目标目录不存在');
  }
  if (kind === 'folder') {
    const fid = Number(id);
    if (target !== null) {
      // 禁止移动到自己的子树
      let cur: number | null = target;
      for (let i = 0; i < 64 && cur !== null; i++) {
        if (cur === fid) throw new HttpError(400, '不能把目录移到它自己里面');
        const row: any = await env.DB.prepare('SELECT parent_id FROM folders WHERE id=?').bind(cur).first();
        cur = row ? (row.parent_id === null ? null : Number(row.parent_id)) : null;
      }
    }
    await env.DB.prepare('UPDATE folders SET parent_id=? WHERE id=?').bind(target, fid).run();
    return json({ ok: true });
  }
  await env.DB.prepare('UPDATE files SET folder_id=? WHERE id=?').bind(target, id).run();
  return json({ ok: true });
}

/* ============================ 缩略图（KV） ============================ */

const THUMB_MAX = 200 * 1024;

export async function putThumbHandler(req: Request, env: any, fileId: string): Promise<Response> {
  await requireAdmin(req, env);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > THUMB_MAX) throw new HttpError(413, '缩略图太大（上限 200KB）');
  const ct = req.headers.get('Content-Type') || 'image/webp';
  if (!/^image\//.test(ct)) throw new HttpError(400, '缩略图必须是图片');
  await env.KV.put(`thumb:${fileId}`, buf, { metadata: { ct } });
  return json({ ok: true, size: buf.byteLength });
}

export async function getThumbHandler(req: Request, env: any, fileId: string): Promise<Response> {
  await requireAny(req, env);
  const v = await env.KV.getWithMetadata(`thumb:${fileId}`, 'arrayBuffer');
  if (!v.value) throw new HttpError(404, '没有缩略图');
  const ct = (v.metadata as any)?.ct || 'image/webp';
  return new Response(v.value, { headers: { 'Content-Type': ct, 'Cache-Control': 'private, max-age=86400' } });
}

export async function thumbListHandler(req: Request, env: any): Promise<Response> {
  await requireAny(req, env);
  const { results } = await env.DB.prepare(
    "SELECT id,name,size,folder_id,created_at FROM files WHERE deleted_at IS NULL AND COALESCE(enc,0) = 0 AND (lower(name) LIKE '%.jpg' OR lower(name) LIKE '%.jpeg' OR lower(name) LIKE '%.png' OR lower(name) LIKE '%.gif' OR lower(name) LIKE '%.webp' OR lower(name) LIKE '%.bmp' OR lower(name) LIKE '%.avif') ORDER BY created_at DESC LIMIT 500",
  ).all();
  const list: any[] = [];
  for (const r of results as any[]) {
    const m = await env.KV.getWithMetadata(`thumb:${r.id}`);
    list.push({ ...r, thumb: !!m.value });
  }
  return json({ photos: list });
}

/* ============================ 打包下载（store zip） ============================ */

const ZIP_MAX_TOTAL = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function zipHandler(req: Request, env: any): Promise<Response> {
  await requireAny(req, env);
  const url = new URL(req.url);
  const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new HttpError(400, '没给文件 id');
  if (ids.length > 200) throw new HttpError(400, '一次最多 200 个文件');
  const files: any[] = [];
  let total = 0;
  for (const id of ids) {
    const f: any = await env.DB.prepare("SELECT * FROM files WHERE id=? AND status='ready' AND deleted_at IS NULL").bind(id).first();
    if (!f) continue;
    if (f.enc) throw new HttpError(400, '加密文件不能打包下载（拿到的是密文）');
    total += Number(f.size);
    if (total > ZIP_MAX_TOTAL) throw new HttpError(413, `打包内容超过 ${ZIP_MAX_TOTAL / 1048576}MB 上限，分几次下载吧`);
    files.push(f);
  }
  if (!files.length) throw new HttpError(404, '没有可打包的文件');

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const used = new Map<string, number>();

  for (const f of files) {
    const data = new Uint8Array(await new Response(await streamDownload(env, String(f.id), 0, Number(f.size) - 1)).arrayBuffer());
    let name = String(f.name).replace(/[\\/\u0000]/g, '_');
    const seen = used.get(name) || 0;
    if (seen) name = `${seen + 1}_${name}`;
    used.set(name, seen + 1);
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 名
    dv.setUint16(8, 0, true); // store
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0x21, true); // 1980-01-01
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + data.length;
  }

  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all: Uint8Array[] = [...parts, ...central, end];
  const body = new Blob(all as any[]);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="pan-${Date.now()}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}

/* ============================ 复制（剪贴板复制用） ============================ */
export async function copyHandler(req: Request, env: any): Promise<Response> {
  await requireAdmin(req, env);
  const b = await req.json<any>().catch(() => ({}));
  const kind = String(b.kind || 'file');
  const id = String(b.id || '');
  const target = b.folderId === null || b.folderId === undefined || b.folderId === '' ? null : Number(b.folderId);
  if (!id) throw new HttpError(400, '缺 id');
  if (kind !== 'file') throw new HttpError(400, '目录复制暂不支持，先用手动新建或 WebDAV COPY');
  const f: any = await env.DB.prepare("SELECT * FROM files WHERE id=? AND status='ready'").bind(id).first();
  if (!f) throw new HttpError(404, '文件不存在');
  const nid = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO files(id,name,folder_id,size,chunk_size,chunks_count,status,sha256,created_at,enc,enc_meta) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(nid, String(f.name), target, f.size, f.chunk_size, f.chunks_count, 'ready', f.sha256, nowISO(), f.enc || 0, f.enc_meta || null).run();
  const { results: cs } = await env.DB.prepare('SELECT idx,account_id,bucket,object_key,size,etag,hash FROM chunks WHERE file_id=? ORDER BY idx').bind(id).all();
  for (const c of cs as any[]) {
    await env.DB.prepare('INSERT INTO chunks(file_id,idx,account_id,bucket,object_key,size,etag,hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(nid, c.idx, c.account_id, c.bucket, c.object_key, c.size, c.etag, c.hash, nowISO()).run();
    if (c.hash) await env.DB.prepare('UPDATE blobs SET refs=refs+1 WHERE hash=?').bind(c.hash).run();
  }
  return json({ ok: true, id: nid });
}


/** 把 R2 分片流读成整块（上限 64MB，超过报错） */
async function readWhole(env: any, file: any): Promise<Uint8Array> {
  const stream = await streamDownload(env, String(file.id), 0, Number(file.size) - 1);
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { parts.push(value); total += value.byteLength; }
    if (total > 64 * 1024 * 1024) throw new HttpError(413, '压缩包超过 64MB，请在本地解压后再传');
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const q of parts) { out.set(q, off); off += q.byteLength; }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const b = new Blob([data as any]);
  const res = new Response(b.stream().pipeThrough(ds));
  return new Uint8Array(await res.arrayBuffer());
}

/** POST /api/files/:id/unzip — 把 zip 里的文件解到同一目录（store + deflate 两种） */
export async function unzipHandler(req: Request, env: any, fileId: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").bind(fileId).first();
  if (!file) throw new HttpError(404, '文件不存在');
  if (file.enc) throw new HttpError(400, '加密文件不能在线解压（服务器拿到的是密文）');
  if (!/\.zip$/i.test(file.name)) throw new HttpError(400, '只支持 .zip');
  const b = (await req.json().catch(() => ({}))) as any;
  const parent = file.folder_id ?? null;

  const buf = await readWhole(env, file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new HttpError(400, '不是有效的 zip');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);

  const folderCache = new Map<string, number | null>();
  folderCache.set('', parent);
  const ensureDir = async (rel: string): Promise<number | null> => {
    if (folderCache.has(rel)) return folderCache.get(rel)!;
    const ix = rel.lastIndexOf('/');
    const parentPath = ix < 0 ? '' : rel.slice(0, ix);
    const name = ix < 0 ? rel : rel.slice(ix + 1);
    const pid = await ensureDir(parentPath);
    const ex = await env.DB.prepare('SELECT id FROM folders WHERE name = ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)')
      .bind(name, pid, pid).first();
    let id = ex?.id;
    if (!id) {
      const r = await env.DB.prepare('INSERT INTO folders(parent_id, name, created_at) VALUES(?,?,?)').bind(pid, name, nowISO()).run();
      id = r.meta.last_row_id;
    }
    folderCache.set(rel, id);
    return id;
  };

  let files = 0;
  let dirs = 0;
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const csize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const lho = dv.getUint32(ptr + 42, true);
    const rawName = new TextDecoder().decode(buf.subarray(ptr + 46, ptr + 46 + nameLen)).replace(/\\/g, '/');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (!rawName || rawName.startsWith('__MACOSX/') || /(^|\/)\._/.test(rawName) || /(^|\/)\.DS_Store$/.test(rawName)) continue;
    if (rawName.endsWith('/')) { await ensureDir(rawName.replace(/\/$/, '')); dirs++; continue; }
    if (rawName.includes('..')) continue;

    // 本地头：跳过文件名/扩展字段
    const lnameLen = dv.getUint16(lho + 26, true);
    const lextraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else continue; // 不支持的其他压缩方式

    const dir = rawName.includes('/') ? await ensureDir(rawName.slice(0, rawName.lastIndexOf('/'))) : parent;
    const base = rawName.slice(rawName.lastIndexOf('/') + 1);
    // 注意：initUpload 会把 chunkSize 夹到 [5MB, 100MB]，所以大于 5MB 的条目要按 up.chunkSize 切片
    const up: any = await initUpload(env, { name: base, size: data.byteLength, folderId: dir, chunkSize: data.byteLength || 1 });
    for (let i = 0; i < up.chunksCount; i++) {
      const s0 = i * up.chunkSize;
      const s1 = Math.min(data.byteLength, s0 + up.chunkSize);
      await putChunk(env, up.uploadId, i, data.buffer.slice(data.byteOffset + s0, data.byteOffset + s1) as ArrayBuffer);
    }
    await completeUpload(env, up.uploadId);
    files++;
    if (names.length < 20) names.push(rawName);
  }
  return json({ ok: true, files, dirs, names });
}
