/**
 * 扩展功能：回收站、标签、收藏、最近访问、搜索、批量操作、移动、缩略图、打包下载
 * 依赖：roles（鉴权）、util（json/HttpError/nowISO）、files（deleteFileDeep）、chunk（streamDownload）
 */
import { requireAdmin, requireAny } from './roles';
import { HttpError, json, nowISO } from './util';
import { deleteFileDeep } from './files';
import { streamDownload } from './chunk';

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
    // 恢复整个子树
    const ids: number[] = [Number(id)];
    for (let i = 0; i < ids.length; i++) {
      const { results } = await env.DB.prepare('SELECT id FROM folders WHERE parent_id = ?').bind(ids[i]).all();
      for (const r of results as any[]) ids.push(Number(r.id));
    }
    for (const x of ids) {
      await env.DB.prepare('UPDATE folders SET deleted_at = NULL WHERE id = ?').bind(x).run();
      await env.DB.prepare('UPDATE files SET deleted_at = NULL WHERE folder_id = ?').bind(x).run();
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
    let files = 0;
    for (const x of ids) {
      const { results: fs } = await env.DB.prepare('SELECT id FROM files WHERE folder_id = ?').bind(x).all();
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
    for (const id of ids) {
      const f = await env.DB.prepare('SELECT id FROM files WHERE id=?').bind(id).first();
      if (f) { await env.DB.prepare('UPDATE files SET folder_id=? WHERE id=?').bind(target, id).run(); n++; }
      else {
        if (target !== null && Number(id) === target) continue;
        await env.DB.prepare('UPDATE folders SET parent_id=? WHERE id=?').bind(target, Number(id)).run();
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
    "SELECT id,name,size,folder_id,created_at FROM files WHERE deleted_at IS NULL AND (lower(name) LIKE '%.jpg' OR lower(name) LIKE '%.jpeg' OR lower(name) LIKE '%.png' OR lower(name) LIKE '%.gif' OR lower(name) LIKE '%.webp' OR lower(name) LIKE '%.bmp' OR lower(name) LIKE '%.avif') ORDER BY created_at DESC LIMIT 500",
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
