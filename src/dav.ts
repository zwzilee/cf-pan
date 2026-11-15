import type { Env } from './types';
import { completeUpload, getChunks, initUpload, maxEndForRequest, putChunk, sha256hex, streamDownload } from './chunk';
import { deleteFileDeep } from './files';

/**
 * WebDAV 网关
 * ------------------------------------------------------------------
 * 后台建一个「WebDAV 挂载」：绑定到某个网盘目录，发一个临时密钥。
 * 客户端用  https://host/dav/<挂载id>/   + Basic(用户名, 密钥)  或
 *          https://host/dav/<挂载id>/<密钥>/                     连接。
 *
 * 平台硬限制（不是实现问题）：
 *   - Worker 请求体 100MB（Free/Pro）→ 单次 PUT 实用上限 95MB
 *   - Worker 内存 128MB → 不能把更大的文件读进内存
 *   - WebDAV 没有通用分块协议 → 大于上限的文件只能走面板/令牌分片上传
 * 读方向没有限制：GET/HEAD 走逐片流式拼接，2GB 的片子也只占几十 KB 内存。
 */

export const DAV_MAX_PUT = 95 * 1024 * 1024;

export interface DavMount {
  id: string;
  name: string;
  folder_id: number | null;
  username: string;
  key_hash: string;
  key_prefix: string;
  readonly: number;
  enabled: number;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

/* ------------------------------ 小工具 ------------------------------ */

function randHex(bytes = 20): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

export function newDavKey(): string {
  return 'wd_' + randHex(20); // 43 字符，肉眼可识别前缀
}

async function sha256Of(s: string): Promise<string> {
  return sha256hex(new TextEncoder().encode(s).buffer as ArrayBuffer);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function mimeFor(name: string): string {
  const e = (name.split('.').pop() || '').toLowerCase();
  const m: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    ts: 'video/mp2t',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json',
    zip: 'application/zip',
    epub: 'application/epub+zip',
  };
  return m[e] || 'application/octet-stream';
}

/* ------------------------------ 挂载 CRUD ------------------------------ */

/** WebDAV 用户名：去空白、不能带冒号，空则回落到 dav */
export function normUser(u?: string | null): string {
  const s = String(u == null ? '' : u).replace(/[:\s]/g, '').trim();
  return s || 'dav';
}

export async function createMount(
  env: Env,
  o: { name: string; folderId: number | null; ttlSec: number | null; readonly: boolean; username?: string },
) {
  const id = crypto.randomUUID();
  const key = newDavKey();
  const username = normUser(o.username);
  const expires = o.ttlSec && o.ttlSec > 0 ? new Date(Date.now() + o.ttlSec * 1000).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO dav_mounts (id, name, folder_id, username, key_hash, key_prefix, readonly, enabled, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, o.name, o.folderId, username, await sha256Of(key), key.slice(0, 10), o.readonly ? 1 : 0, expires, new Date().toISOString())
    .run();
  return { id, username, key, expires_at: expires };
}

export async function listMounts(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.name, m.folder_id, m.username, m.key_prefix, m.readonly, m.enabled, m.expires_at,
            m.created_at, m.last_used_at, f.name AS folder_name
       FROM dav_mounts m LEFT JOIN folders f ON f.id = m.folder_id
      ORDER BY m.created_at DESC`,
  ).all<any>();
  return results;
}

export async function getMount(env: Env, id: string): Promise<DavMount | null> {
  return await env.DB.prepare('SELECT * FROM dav_mounts WHERE id = ?').bind(id).first<DavMount>();
}

export async function deleteMount(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM dav_mounts WHERE id = ?').bind(id).run();
}

export async function updateMount(env: Env, id: string, o: { enabled?: boolean; readonly?: boolean; ttlSec?: number | null; name?: string; username?: string }) {
  const sets: string[] = [];
  const vals: any[] = [];
  if (typeof o.enabled === 'boolean') {
    sets.push('enabled = ?');
    vals.push(o.enabled ? 1 : 0);
  }
  if (typeof o.readonly === 'boolean') {
    sets.push('readonly = ?');
    vals.push(o.readonly ? 1 : 0);
  }
  if (o.name !== undefined) {
    sets.push('name = ?');
    vals.push(o.name);
  }
  if (o.username !== undefined) {
    sets.push('username = ?');
    vals.push(normUser(o.username));
  }
  if (o.ttlSec !== undefined) {
    sets.push('expires_at = ?');
    vals.push(o.ttlSec && o.ttlSec > 0 ? new Date(Date.now() + o.ttlSec * 1000).toISOString() : null);
  }
  if (!sets.length) return;
  vals.push(id);
  await env.DB.prepare(`UPDATE dav_mounts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function regenKey(env: Env, id: string) {
  const key = newDavKey();
  await env.DB.prepare('UPDATE dav_mounts SET key_hash = ?, key_prefix = ? WHERE id = ?')
    .bind(await sha256Of(key), key.slice(0, 10), id)
    .run();
  return { key };
}

/* ------------------------------ 认证 ------------------------------ */

async function resolveAuth(req: Request, mount: DavMount, segs: string[]): Promise<{ ok: boolean; rest: string[] }> {
  // ① 密钥写在 URL 里：/dav/<id>/wd_xxx/...
  if (segs.length && segs[0].startsWith('wd_')) {
    if ((await sha256Of(segs[0])) === mount.key_hash) return { ok: true, rest: segs.slice(1) };
  }
  // ② Basic 认证：用户名随意，密码填密钥
  const hdr = req.headers.get('Authorization') || '';
  if (hdr.startsWith('Basic ')) {
    try {
      const dec = atob(hdr.slice(6).trim());
      const i = dec.indexOf(':');
      const user = i >= 0 ? dec.slice(0, i) : '';
      const pass = i >= 0 ? dec.slice(i + 1) : dec;
      const nameOk = !user || user === mount.username;
      if (nameOk && (await sha256Of(pass)) === mount.key_hash) return { ok: true, rest: segs };
    } catch {
      /* 解不开就当没认证 */
    }
  }
  return { ok: false, rest: segs };
}

function unauthorized(): Response {
  return new Response('需要 WebDAV 认证', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="PAN R2 WebDAV", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/* ------------------------------ 路径解析 ------------------------------ */

type Node = { kind: 'folder'; id: number | null; name: string; row: any } | { kind: 'file'; id: string; name: string; row: any };

function dec(segs: string[]): string[] {
  return segs.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

async function resolveNode(env: Env, mount: DavMount, segsIn: string[]): Promise<Node | null> {
  const segs = dec(segsIn);
  let curId: number | null = mount.folder_id ?? null;
  let curName = mount.name;

  for (let i = 0; i < segs.length; i++) {
    const name = segs[i];
    const last = i === segs.length - 1;
    const folder = await env.DB.prepare(
      curId === null
        ? 'SELECT id, name, created_at FROM folders WHERE parent_id IS NULL AND deleted_at IS NULL AND name = ? ORDER BY id LIMIT 1'
        : 'SELECT id, name, created_at FROM folders WHERE parent_id = ? AND deleted_at IS NULL AND name = ? ORDER BY id LIMIT 1',
    )
      .bind(...(curId === null ? [name] : [curId, name]))
      .first<any>();
    if (folder) {
      curId = folder.id;
      curName = folder.name;
      if (last) return { kind: 'folder', id: folder.id, name: folder.name, row: folder };
      continue;
    }
    // 文件只能出现在最后一段
    const file = await env.DB.prepare(
      curId === null
        ? "SELECT id, name, size, chunk_size, chunks_count, folder_id, created_at FROM files WHERE status='ready' AND deleted_at IS NULL AND folder_id IS NULL AND name = ? ORDER BY created_at DESC LIMIT 1"
        : "SELECT id, name, size, chunk_size, chunks_count, folder_id, created_at FROM files WHERE status='ready' AND deleted_at IS NULL AND folder_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(...(curId === null ? [name] : [curId, name]))
      .first<any>();
    if (file && last) return { kind: 'file', id: file.id, name: file.name, row: file };
    return null;
  }
  return { kind: 'folder', id: curId, name: curName, row: { id: curId, name: curName } };
}

async function childrenOf(env: Env, folderId: number | null) {
  const folders = await env.DB.prepare(
    folderId === null
      ? 'SELECT id, name, created_at FROM folders WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY name'
      : 'SELECT id, name, created_at FROM folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY name',
  )
    .bind(...(folderId === null ? [] : [folderId]))
    .all<any>();
  const files = await env.DB.prepare(
    folderId === null
      ? "SELECT id, name, size, created_at FROM files WHERE status='ready' AND deleted_at IS NULL AND folder_id IS NULL ORDER BY name"
      : "SELECT id, name, size, created_at FROM files WHERE status='ready' AND deleted_at IS NULL AND folder_id = ? ORDER BY name",
  )
    .bind(...(folderId === null ? [] : [folderId]))
    .all<any>();
  return { folders: folders.results as any[], files: files.results as any[] };
}

/* ------------------------------ XML ------------------------------ */

function hrefFor(mountId: string, segs: string[], dir: boolean): string {
  const parts = ['dav', mountId, ...segs].map((s) => encodeURIComponent(s));
  let p = '/' + parts.join('/');
  if (dir && !p.endsWith('/')) p += '/';
  return p;
}

function entryXml(href: string, name: string, isDir: boolean, size: number, mtime: string, mime: string): string {
  const lm = mtime ? new Date(mtime).toUTCString() : new Date().toUTCString();
  const rt = isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
  return (
    '<D:response>' +
    `<D:href>${esc(href)}</D:href>` +
    '<D:propstat><D:prop>' +
    `<D:displayname>${esc(name)}</D:displayname>` +
    `<D:getcontentlength>${isDir ? 0 : size}</D:getcontentlength>` +
    `<D:getcontenttype>${esc(isDir ? 'httpd/unix-directory' : mime)}</D:getcontenttype>` +
    `<D:getlastmodified>${lm}</D:getlastmodified>` +
    rt +
    '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>' +
    '<D:lockdiscovery/>' +
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
    '</D:response>'
  );
}

function multistatus(body: string): Response {
  return new Response(
    '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' + body + '</D:multistatus>',
    { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
}

/* ------------------------------ 文件读写 ------------------------------ */

async function serveNode(env: Env, req: Request, file: any, headOnly: boolean): Promise<Response> {
  let start = 0;
  let end = file.size - 1;
  let status = 200;
  const range = req.headers.get('Range');
  if (range) {
    const mm = /bytes=(\d*)-(\d*)/.exec(range);
    if (mm) {
      if (mm[1]) start = parseInt(mm[1], 10);
      if (mm[2]) end = parseInt(mm[2], 10);
      status = 206;
    }
  }
  if (start < 0) start = 0;
  if (end >= file.size) end = file.size - 1;
  if (start > end) return new Response('Range 不合法', { status: 416 });

  const rows = await getChunks(env, file.id);
  const capEnd = maxEndForRequest(rows, start);
  if (end > capEnd) {
    end = capEnd;
    status = 206;
  }
  const headers: Record<string, string> = {
    'Content-Type': mimeFor(file.name),
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Last-Modified': file.created_at ? new Date(file.created_at).toUTCString() : new Date().toUTCString(),
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
  if (end < file.size - 1) headers['X-Segment-Next'] = String(end + 1);

  if (headOnly) return new Response(null, { status, headers });
  const body = await streamDownload(env, file.id, start, end, rows);
  return new Response(body, { status, headers });
}

async function findChildByName(env: Env, folderId: number | null, name: string) {
  const file = await env.DB.prepare(
    folderId === null
      ? "SELECT id FROM files WHERE status='ready' AND deleted_at IS NULL AND folder_id IS NULL AND name = ?"
      : "SELECT id FROM files WHERE status='ready' AND deleted_at IS NULL AND folder_id = ? AND name = ?",
  )
    .bind(...(folderId === null ? [name] : [folderId, name]))
    .first<any>();
  const folder = await env.DB.prepare(
    folderId === null
      ? 'SELECT id FROM folders WHERE parent_id IS NULL AND deleted_at IS NULL AND name = ?'
      : 'SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL AND name = ?',
  )
    .bind(...(folderId === null ? [name] : [folderId, name]))
    .first<any>();
  return { fileId: file?.id as string | undefined, folderId: folder?.id as number | undefined };
}

async function copyFileRow(env: Env, fileId: string, destFolderId: number | null, destName: string): Promise<string> {
  const f = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first<any>();
  if (!f) throw new Error('源文件不存在');
  const chunks = await getChunks(env, fileId);
  const newId = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO files (id, name, folder_id, size, chunk_size, chunks_count, status, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    ).bind(newId, destName, destFolderId, f.size, f.chunk_size, f.chunks_count, f.sha256 ?? null, new Date().toISOString()),
  ];
  const hashes = new Set<string>();
  for (const c of chunks as any[]) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO chunks (file_id, idx, hash, account_id, bucket, object_key, size, etag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(newId, c.idx, c.hash ?? null, c.account_id, c.bucket, c.object_key, c.size, c.etag, new Date().toISOString()),
    );
    if (c.hash) hashes.add(c.hash);
  }
  await env.DB.batch(stmts);
  for (const h of hashes) {
    await env.DB.prepare('UPDATE blobs SET refs = refs + 1 WHERE hash = ?').bind(h).run();
  }
  return newId;
}

async function copyFolderRec(env: Env, srcId: number, destParent: number | null, destName: string, depth = 0): Promise<void> {
  if (depth > 32) throw new Error('目录嵌套太深');
  const r = await env.DB.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)')
    .bind(destParent, destName, new Date().toISOString())
    .run();
  const newId = Number(r.meta.last_row_id);
  const { folders, files } = await childrenOf(env, srcId);
  for (const f of files) await copyFileRow(env, f.id, newId, f.name);
  for (const d of folders) await copyFolderRec(env, d.id, newId, d.name, depth + 1);
}

/* ------------------------------ 方法分发 ------------------------------ */

export async function davEntry(req: Request, env: Env, mountId: string, segsIn: string[]): Promise<Response> {
  const mount = await getMount(env, mountId);
  if (!mount) return new Response('WebDAV 挂载不存在', { status: 404 });

  const auth = await resolveAuth(req, mount, segsIn);
  if (!auth.ok) return unauthorized();
  if (!mount.enabled) return new Response('这个 WebDAV 挂载已停用', { status: 403 });
  if (mount.expires_at && Date.parse(mount.expires_at) < Date.now())
    return new Response('这个 WebDAV 密钥已过期，去后台重新生成', { status: 403 });

  const segs = auth.rest;
  const ro = !!mount.readonly;
  const m = req.method.toUpperCase();

  // 记录最后使用时间（不阻塞响应）
  env.DB.prepare('UPDATE dav_mounts SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), mount.id).run().catch(() => {});

  if (m === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        DAV: '1, 2',
        Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK',
        'MS-Author-Via': 'DAV',
        'Content-Length': '0',
      },
    });
  }

  if (m === 'PROPFIND') return await davPropfind(req, env, mount, segs);

  if (m === 'GET' || m === 'HEAD') {
    const node = await resolveNode(env, mount, segs);
    if (!node) return new Response('没找到', { status: 404 });
    if (node.kind === 'folder') return await davPropfind(req, env, mount, segs);
    return await serveNode(env, req, node.row, m === 'HEAD');
  }

  // 以下都是写操作
  if (ro) return new Response('这个挂载是只读的', { status: 403 });

  if (m === 'PUT') return await davPut(req, env, mount, segs);
  if (m === 'MKCOL') return await davMkcol(env, mount, segs);
  if (m === 'DELETE') return await davDelete(env, mount, segs);
  if (m === 'MOVE') return await davMove(req, env, mount, segs);
  if (m === 'COPY') return await davCopy(req, env, mount, segs);
  if (m === 'PROPPATCH') return await davProppatch(req, env, mount, segs);
  if (m === 'LOCK') return davLock(segs);
  if (m === 'UNLOCK') return new Response(null, { status: 204 });

  return new Response('不支持的方法：' + m, { status: 405, headers: { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK' } });
}

async function davPropfind(req: Request, env: Env, mount: DavMount, segs: string[]): Promise<Response> {
  const node = await resolveNode(env, mount, segs);
  if (!node) return new Response('没找到', { status: 404 });
  const depth = (req.headers.get('Depth') || '1').toLowerCase();
  const wantDepth1 = depth !== '0';

  const parts: string[] = [];
  const rootName = segs.length ? node.name : mount.name;
  const rootDir = node.kind === 'folder';
  parts.push(
    entryXml(
      hrefFor(mount.id, segs, rootDir),
      rootName,
      rootDir,
      node.kind === 'file' ? node.row.size : 0,
      node.row?.created_at || '',
      node.kind === 'file' ? mimeFor(node.name) : 'httpd/unix-directory',
    ),
  );

  if (rootDir && wantDepth1) {
    const { folders, files } = await childrenOf(env, node.id);
    for (const d of folders) {
      parts.push(
        entryXml(hrefFor(mount.id, [...segs, d.name], true), d.name, true, 0, d.created_at, 'httpd/unix-directory'),
      );
    }
    for (const f of files) {
      parts.push(entryXml(hrefFor(mount.id, [...segs, f.name], false), f.name, false, f.size, f.created_at, mimeFor(f.name)));
    }
  }
  return multistatus(parts.join(''));
}

async function davProppatch(req: Request, env: Env, mount: DavMount, segs: string[]): Promise<Response> {
  const node = await resolveNode(env, mount, segs);
  if (!node) return new Response('没找到', { status: 404 });
  return multistatus(
    '<D:response>' +
      `<D:href>${esc(hrefFor(mount.id, segs, node.kind === 'folder'))}</D:href>` +
      '<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
      '</D:response>',
  );
}

async function davPut(req: Request, env: Env, mount: DavMount, segs: string[]): Promise<Response> {
  if (!segs.length) return new Response('不能往根路径 PUT', { status: 405 });
  const parentSegs = segs.slice(0, -1);
  const name = dec([segs[segs.length - 1]])[0];
  const parent = await resolveNode(env, mount, parentSegs);
  if (!parent || parent.kind !== 'folder') return new Response('上级目录不存在', { status: 409 });

  const declared = Number(req.headers.get('Content-Length') || '0');
  if (declared > DAV_MAX_PUT)
    return new Response(
      `文件太大：WebDAV 单次 PUT 上限 ${(DAV_MAX_PUT / 1048576).toFixed(0)}MB（Cloudflare Worker 请求体限制）。请用面板或 API 令牌分片上传。`,
      { status: 413 },
    );

  const buf = await req.arrayBuffer();
  if (buf.byteLength > DAV_MAX_PUT)
    return new Response(`文件太大：超过 ${(DAV_MAX_PUT / 1048576).toFixed(0)}MB，请走分片上传。`, { status: 413 });

  const existed = await findChildByName(env, parent.id, name);
  let replaced = false;
  if (existed.fileId) {
    await deleteFileDeep(env, existed.fileId);
    replaced = true;
  } else if (existed.folderId) {
    return new Response('同名目录已存在', { status: 405 });
  }

  const { uploadId } = await initUpload(env, { name, folderId: parent.id, size: buf.byteLength, chunkSize: buf.byteLength || 1 });
  await putChunk(env, uploadId, 0, buf);
  const { fileId } = await completeUpload(env, uploadId);
  return new Response(null, {
    status: replaced ? 204 : 201,
    headers: { 'Content-Length': '0', 'X-File-Id': fileId },
  });
}

async function davMkcol(env: Env, mount: DavMount, segs: string[]): Promise<Response> {
  if (!segs.length) return new Response('根已存在', { status: 405 });
  const parentSegs = segs.slice(0, -1);
  const name = dec([segs[segs.length - 1]])[0];
  const parent = await resolveNode(env, mount, parentSegs);
  if (!parent || parent.kind !== 'folder') return new Response('上级目录不存在', { status: 409 });
  const exists = await findChildByName(env, parent.id, name);
  if (exists.fileId || exists.folderId) return new Response('已存在同名项', { status: 405 });
  await env.DB.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)')
    .bind(parent.id, name, new Date().toISOString())
    .run();
  return new Response(null, { status: 201, headers: { 'Content-Length': '0' } });
}

async function davDelete(env: Env, mount: DavMount, segs: string[]): Promise<Response> {
  if (!segs.length) return new Response('不能删挂载根目录', { status: 403 });
  const node = await resolveNode(env, mount, segs);
  if (!node) return new Response('没找到', { status: 404 });
  if (node.kind === 'file') {
    await deleteFileDeep(env, node.id as string);
    return new Response(null, { status: 204 });
  }
  // 目录：必须空
  const id = node.id as number;
  const files = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id = ? AND deleted_at IS NULL').bind(id).first<any>();
  const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id = ? AND deleted_at IS NULL').bind(id).first<any>();
  if ((files?.n ?? 0) > 0 || (subs?.n ?? 0) > 0) return new Response('目录不是空的', { status: 409 });
  await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id).run();
  return new Response(null, { status: 204 });
}

function destSegs(req: Request, mount: DavMount): string[] | null {
  const d = req.headers.get('Destination');
  if (!d) return null;
  let u: URL;
  try {
    u = new URL(d, 'https://x/');
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'dav' || parts[1] !== mount.id) return null;
  let rest = parts.slice(2);
  if (rest.length && rest[0].startsWith('wd_')) rest = rest.slice(1);
  return rest;
}

async function davMove(req: Request, env: Env, mount: DavMount, segs: string[]): Promise<Response> {
  if (!segs.length) return new Response('不能移动根目录', { status: 403 });
  const node = await resolveNode(env, mount, segs);
  if (!node) return new Response('没找到', { status: 404 });
  const dst = destSegs(req, mount);
  if (!dst || !dst.length) return new Response('Destination 不合法或跨挂载', { status: 400 });
  const dstParent = await resolveNode(env, mount, dst.slice(0, -1));
  if (!dstParent || dstParent.kind !== 'folder') return new Response('目标目录不存在', { status: 409 });
  const dstName = dec([dst[dst.length - 1]])[0];

  const overwrite = (req.headers.get('Overwrite') || 'T').toUpperCase() !== 'F';
  const exist = await findChildByName(env, dstParent.id, dstName);
  if (exist.fileId || exist.folderId) {
    if (!overwrite) return new Response('目标已存在', { status: 412 });
    if (exist.fileId) await deleteFileDeep(env, exist.fileId);
    else {
      const id = exist.folderId as number;
      const n = await env.DB.prepare(
        'SELECT (SELECT COUNT(*) FROM files WHERE folder_id=? AND deleted_at IS NULL) + (SELECT COUNT(*) FROM folders WHERE parent_id=? AND deleted_at IS NULL) AS n',
      )
        .bind(id, id)
        .first<any>();
      if ((n?.n ?? 0) > 0) return new Response('目标目录非空', { status: 409 });
      await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id).run();
    }
  }

  if (node.kind === 'file') {
    await env.DB.prepare('UPDATE files SET folder_id = ?, name = ? WHERE id = ?').bind(dstParent.id, dstName, node.id).run();
  } else {
    const srcId = node.id as number;
    // 防止把目录移进自己的子孙目录
    let cur: number | null = dstParent.id;
    while (cur !== null) {
      if (cur === srcId) return new Response('不能把目录移动到自身内部', { status: 409 });
      const row: any = await env.DB.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(cur).first<any>();
      cur = row ? (row.parent_id ?? null) : null;
    }
    await env.DB.prepare('UPDATE folders SET parent_id = ?, name = ? WHERE id = ?').bind(dstParent.id, dstName, srcId).run();
  }
  return new Response(null, { status: 201, headers: { 'Content-Length': '0' } });
}

async function davCopy(req: Request, env: Env, mount: DavMount, segs: string[]): Promise<Response> {
  if (!segs.length) return new Response('不能复制根目录', { status: 403 });
  const node = await resolveNode(env, mount, segs);
  if (!node) return new Response('没找到', { status: 404 });
  const dst = destSegs(req, mount);
  if (!dst || !dst.length) return new Response('Destination 不合法或跨挂载', { status: 400 });
  const dstParent = await resolveNode(env, mount, dst.slice(0, -1));
  if (!dstParent || dstParent.kind !== 'folder') return new Response('目标目录不存在', { status: 409 });
  const dstName = dec([dst[dst.length - 1]])[0];

  const overwrite = (req.headers.get('Overwrite') || 'T').toUpperCase() !== 'F';
  const exist = await findChildByName(env, dstParent.id, dstName);
  if (exist.fileId || exist.folderId) {
    if (!overwrite) return new Response('目标已存在', { status: 412 });
    if (exist.fileId) await deleteFileDeep(env, exist.fileId);
    else return new Response('目标目录已存在', { status: 409 });
  }

  if (node.kind === 'file') {
    await copyFileRow(env, node.id as string, dstParent.id, dstName);
  } else {
    await copyFolderRec(env, node.id as number, dstParent.id, dstName);
  }
  return new Response(null, { status: 201, headers: { 'Content-Length': '0' } });
}

function davLock(segs: string[]): Response {
  const token = 'opaquelocktoken:' + crypto.randomUUID();
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
    '<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>' +
    '<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>' +
    `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
    '</D:activelock></D:lockdiscovery></D:prop>';
  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` },
  });
}
