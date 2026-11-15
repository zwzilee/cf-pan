import type { Env } from './types';
import { cookie, HttpError, json } from './util';
import { hashPassword, requireAuth, signJWT, verifyPassword } from './auth';
import { encryptSecret } from './crypto';
import * as store from './store';
import * as s3 from './s3';
import { completeUpload, getChunks, initUpload, maxEndForRequest, putChunk, streamDownload } from './chunk';
import { checkShareUsable, createShareToken, revokeShare, verifyShareToken } from './share';

const SESSION_TTL = 60 * 60 * 12; // 12h

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const p = url.pathname;
      const m = req.method;
      const seg = p.split('/').filter(Boolean);

      // ================= 公开分享（免登录，必须在鉴权之前） =================
      if (seg[0] === 's' && seg[1]) return await publicShare(req, env, seg[1], seg[2]);
      if (p === '/api/public/info' && m === 'GET') return await publicInfo(req, env);

      // ================= 认证 =================
      if (p === '/api/login' && m === 'POST') return await login(req, env);
      if (p === '/api/logout' && m === 'POST')
        return json({ ok: true }, { headers: { 'Set-Cookie': cookie('sid', '', 0) } });
      if (p === '/api/me' && m === 'GET') {
        const u = await requireAuth(req, env);
        return json({ ok: true, user: { uid: u.uid, role: u.role } });
      }
      if (p === '/api/stats' && m === 'GET') return await stats(req, env);

      // ================= 账号池（管理员） =================
      if (p === '/api/accounts' && m === 'GET') return await listAccountsHandler(req, env);
      if (p === '/api/accounts' && m === 'POST') return await createAccountHandler(req, env);
      if (seg[0] === 'api' && seg[1] === 'accounts' && seg[2] && seg[3] === 'test' && m === 'POST')
        return await testAccountHandler(req, env, Number(seg[2]));
      if (seg[0] === 'api' && seg[1] === 'accounts' && seg[2] && m === 'PATCH')
        return await updateAccountHandler(req, env, Number(seg[2]));
      if (seg[0] === 'api' && seg[1] === 'accounts' && seg[2] && m === 'DELETE')
        return await deleteAccountHandler(req, env, Number(seg[2]));

      // ================= 目录 / 文件 =================
      if (p === '/api/folders' && m === 'GET') return await listFolders(req, env);
      if (p === '/api/folders' && m === 'POST') return await createFolder(req, env);
      if (p === '/api/files' && m === 'GET') return await listFiles(req, env);

      // ================= 分享管理 =================
      if (seg[0] === 'api' && seg[1] === 'files' && seg[2] && seg[3] === 'share' && m === 'POST')
        return await createShareHandler(req, env, seg[2]);
      if (p === '/api/shares' && m === 'GET') return await listSharesHandler(req, env);
      if (seg[0] === 'api' && seg[1] === 'shares' && seg[2] && m === 'DELETE')
        return await revokeShareHandler(req, env, seg[2]);

      // ================= 分片上传 =================
      if (p === '/api/upload/init' && m === 'POST') return await initHandler(req, env);
      if (seg[0] === 'api' && seg[1] === 'upload' && seg[2] && seg[3] === 'chunk' && seg[4] && m === 'PUT')
        return await putChunkHandler(req, env, seg[2], Number(seg[4]));
      if (seg[0] === 'api' && seg[1] === 'upload' && seg[2] && seg[3] === 'complete' && m === 'POST')
        return await completeHandler(req, env, seg[2]);

      // ================= 下载 / 删除 =================
      if (seg[0] === 'api' && seg[1] === 'files' && seg[2] && seg[3] === 'download' && m === 'GET')
        return await download(req, env, seg[2]);
      if (seg[0] === 'api' && seg[1] === 'files' && seg[2] && seg[3] === 'play' && m === 'GET')
        return await play(req, env, seg[2]);
      if (seg[0] === 'api' && seg[1] === 'files' && seg[2] && m === 'DELETE')
        return await deleteFile(req, env, seg[2]);

      if (p === '/api/health') return json({ ok: true, name: env.PUBLIC_APP_NAME || 'PAN R2' });

      // ================= 静态前端 =================
      if (env.ASSETS && !p.startsWith('/api/')) return env.ASSETS.fetch(req);
      return json({ error: 'Not Found' }, { status: 404 });
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
      return json({ error: e?.message || String(e) }, { status: 500 });
    }
  },
};

// ============ 认证 ============
async function ensureBootstrap(env: Env): Promise<void> {
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<any>();
  if (c && c.n > 0) return;
  const boot = env.BOOTSTRAP_ADMIN;
  if (!boot) return;
  const idx = boot.indexOf(':');
  const username = boot.slice(0, idx);
  const password = boot.slice(idx + 1);
  if (!username || !password) return;
  const hash = await hashPassword(password);
  await env.DB.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .bind(username, hash, 'admin', new Date().toISOString())
    .run();
}

async function login(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as any;
  const username = String(b.username || '');
  const password = String(b.password || '');
  await ensureBootstrap(env);
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<any>();
  if (!user || !(await verifyPassword(password, user.pass_hash))) throw new HttpError(401, '用户名或密码错误');
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const token = await signJWT({ uid: user.id, role: user.role, exp }, env.JWT_SECRET);
  return json({ ok: true, role: user.role }, { headers: { 'Set-Cookie': cookie('sid', token, SESSION_TTL) } });
}

// ============ 统计 ============
async function stats(req: Request, env: Env): Promise<Response> {
  await requireAuth(req, env);
  const acc = await env.DB.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(capacity_bytes),0) AS cap, COALESCE(SUM(used_bytes),0) AS used FROM accounts WHERE enabled = 1',
  ).first<any>();
  const files = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS size FROM files WHERE status = 'ready'",
  ).first<any>();
  return json({ accounts: acc.n, capacity: acc.cap, used: acc.used, files: files.n, filesSize: files.size });
}

// ============ 账号池 ============
async function listAccountsHandler(req: Request, env: Env): Promise<Response> {
  await requireAuth(req, env, 'admin');
  const list = await store.listAccounts(env);
  return json({
    accounts: list.map((a) => ({
      id: a.id,
      name: a.name,
      account_id: a.account_id,
      bucket: a.bucket,
      access_key_id: a.access_key_id,
      capacity_bytes: a.capacity_bytes,
      used_bytes: a.used_bytes,
      free_bytes: Math.max(0, a.capacity_bytes - a.used_bytes),
      weight: a.weight,
      enabled: a.enabled,
    })),
  });
}

async function createAccountHandler(req: Request, env: Env): Promise<Response> {
  await requireAuth(req, env, 'admin');
  const b = (await req.json().catch(() => ({}))) as any;
  for (const k of ['name', 'account_id', 'bucket', 'access_key_id', 'secret_access_key']) {
    if (!b[k]) throw new HttpError(400, `缺少字段 ${k}`);
  }
  const id = await store.createAccount(env, {
    name: String(b.name),
    account_id: String(b.account_id),
    bucket: String(b.bucket),
    access_key_id: String(b.access_key_id),
    secret_access_key: String(b.secret_access_key),
    capacity_bytes: b.capacity_bytes ? Number(b.capacity_bytes) : undefined,
    weight: b.weight ? Number(b.weight) : undefined,
  });
  return json({ id });
}

async function updateAccountHandler(req: Request, env: Env, id: number): Promise<Response> {
  await requireAuth(req, env, 'admin');
  const b = (await req.json().catch(() => ({}))) as any;
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of ['name', 'capacity_bytes', 'weight', 'enabled']) {
    if (k in b) {
      sets.push(`${k} = ?`);
      vals.push(b[k]);
    }
  }
  if (b.access_key_id) {
    sets.push('access_key_id = ?');
    vals.push(String(b.access_key_id));
  }
  if (b.secret_access_key) {
    sets.push('secret_access_key = ?');
    vals.push(await encryptSecret(env.MASTER_KEY, String(b.secret_access_key)));
  }
  if (!sets.length) throw new HttpError(400, '没有可更新字段');
  vals.push(id);
  await env.DB.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return json({ ok: true });
}

async function testAccountHandler(req: Request, env: Env, id: number): Promise<Response> {
  await requireAuth(req, env, 'admin');
  const a = await store.getAccount(env, id);
  if (!a) throw new HttpError(404, '账号不存在');
  try {
    const ok = await s3.s3HeadBucket(a);
    return json({ ok, message: ok ? '连通正常' : 'HEAD 桶失败：检查 Account ID / 桶名 / 权限' });
  } catch (e: any) {
    return json({ ok: false, message: e?.message || String(e) });
  }
}

async function deleteAccountHandler(req: Request, env: Env, id: number): Promise<Response> {
  await requireAuth(req, env, 'admin');
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE account_id = ?').bind(id).first<any>();
  if (used && used.n > 0) throw new HttpError(400, '该账号下还有分片，先删除对应文件再移除');
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ============ 目录 / 文件 ============
async function listFolders(req: Request, env: Env): Promise<Response> {
  await requireAuth(req, env);
  const { results } = await env.DB.prepare('SELECT id, parent_id, name, created_at FROM folders ORDER BY name').all();
  return json({ folders: results });
}

async function createFolder(req: Request, env: Env): Promise<Response> {
  await requireAuth(req, env);
  const b = (await req.json().catch(() => ({}))) as any;
  const r = await env.DB.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)')
    .bind(b.parentId ?? null, String(b.name || '新建文件夹'), new Date().toISOString())
    .run();
  return json({ id: r.meta.last_row_id });
}

async function listFiles(req: Request, env: Env): Promise<Response> {
  await requireAuth(req, env);
  const f = new URL(req.url).searchParams.get('folder');
  const folderId = f === null || f === '' ? null : Number(f);
  const sql =
    folderId === null
      ? "SELECT id,name,size,chunks_count,folder_id,created_at FROM files WHERE status='ready' AND folder_id IS NULL ORDER BY created_at DESC"
      : "SELECT id,name,size,chunks_count,folder_id,created_at FROM files WHERE status='ready' AND folder_id = ? ORDER BY created_at DESC";
  const stmt = folderId === null ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(folderId);
  const { results } = await stmt.all();
  return json({ files: results });
}

// ============ 分享 ============
async function createShareHandler(req: Request, env: Env, fileId: string): Promise<Response> {
  await requireAuth(req, env);
  const file = await env.DB.prepare("SELECT id, name, size FROM files WHERE id = ? AND status = 'ready'")
    .bind(fileId)
    .first<any>();
  if (!file) throw new HttpError(404, '文件不存在');

  const b = (await req.json().catch(() => ({}))) as any;
  const ttlSec = Math.min(Math.max(Number(b.ttlSec) || 7 * 86400, 60), 365 * 86400);
  const maxDownloads = b.maxDownloads ? Number(b.maxDownloads) : undefined;

  const { token, jti, exp } = await createShareToken(env, fileId, ttlSec, maxDownloads);
  return json({ ok: true, jti, exp, url: `/s/${token}`, token });
}

async function listSharesHandler(req: Request, env: Env): Promise<Response> {
  await requireAuth(req, env, 'admin');
  const listed = await env.KV.list({ prefix: 'share:', limit: 200 });
  const out = await Promise.all(
    listed.keys.map(async (k) => {
      const raw = await env.KV.get(k.name);
      if (!raw) return null;
      const rec = JSON.parse(raw) as { fileId: string; max: number; used: number };
      const f = await env.DB.prepare('SELECT name, size FROM files WHERE id = ?').bind(rec.fileId).first<any>();
      return {
        jti: k.name.slice('share:'.length),
        fileId: rec.fileId,
        fileName: f?.name ?? '(文件已删除)',
        size: f?.size ?? 0,
        max: rec.max,
        used: rec.used,
        expiresAt: k.expiration ? new Date(k.expiration * 1000).toISOString() : null,
      };
    }),
  );
  return json({ shares: out.filter(Boolean) });
}

async function revokeShareHandler(req: Request, env: Env, jti: string): Promise<Response> {
  await requireAuth(req, env, 'admin');
  const ok = await revokeShare(env, jti);
  if (!ok) throw new HttpError(404, '分享不存在或已过期');
  return json({ ok: true });
}

/** 公开信息：分享页首屏用，不占下载次数 */
async function publicInfo(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get('token') || '';
  const claims = await verifyShareToken(env, token);
  const rec = await checkShareUsable(env, claims, false);
  const f = await env.DB.prepare("SELECT name, size, created_at FROM files WHERE id = ? AND status = 'ready'")
    .bind(claims.f)
    .first<any>();
  if (!f) throw new HttpError(404, '文件已被删除');
  return json({
    name: f.name,
    size: f.size,
    createdAt: f.created_at,
    expiresAt: new Date(claims.e * 1000).toISOString(),
    remaining: rec.max > 0 ? Math.max(0, rec.max - rec.used) : -1,
  });
}

/** /s/<token> —— 浏览器来就回页面，带 ?dl=1 或非 HTML Accept 就回文件 */
async function publicShare(req: Request, env: Env, token: string, action?: string): Promise<Response> {
  const claims = await verifyShareToken(env, token);
  const url = new URL(req.url);
  const wantFile = action === 'download' || url.searchParams.has('dl');

  if (!wantFile) {
    const rec = await checkShareUsable(env, claims, false);
    const f = await env.DB.prepare("SELECT name, size FROM files WHERE id = ? AND status = 'ready'")
      .bind(claims.f)
      .first<any>();
    if (!f) throw new HttpError(404, '文件已被删除');
    const html = sharePage(token, f.name, f.size, claims.e, rec.max > 0 ? rec.max - rec.used : -1);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const rec = await checkShareUsable(env, claims, true);
  if (rec.max > 0 && rec.used > rec.max) throw new HttpError(410, '分享链接下载次数已用完');

  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").bind(claims.f).first<any>();
  if (!file) throw new HttpError(404, '文件已被删除');
  return await serveFile(req, env, file);
}

function sharePage(token: string, name: string, size: number, exp: number, remaining: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const gb = (n: number) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  };
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)} · PAN R2</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.c{background:#161b22;border:1px solid #2b333d;border-radius:14px;padding:30px;max-width:420px;width:calc(100% - 40px);text-align:center}
h1{font-size:16px;word-break:break-all;margin:0 0 6px}.m{color:#8b949e;font-size:12px;margin-bottom:20px}
a.btn{display:block;background:#2ea043;color:#fff;text-decoration:none;padding:11px;border-radius:7px;font-size:14px}
a.btn:hover{background:#3fb950}.f{margin-top:14px;color:#8b949e;font-size:11px}</style></head>
<body><div class="c"><h1>${esc(name)}</h1>
<div class="m">${gb(size)} · ${remaining >= 0 ? `剩余 ${remaining} 次下载` : '不限次数'}</div>
<a class="btn" href="/s/${token}?dl=1">下载</a>
<div class="f">有效期至 ${new Date(exp * 1000).toLocaleString('zh-CN')}<br>由 PAN R2 分享</div>
</div></body></html>`;
}

// ============ 分片上传 ============
async function initHandler(req: Request, env: Env): Promise<Response> {
  await requireAuth(req, env);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.name || !b.size) throw new HttpError(400, '缺少 name / size');
  return json(
    await initUpload(env, {
      name: String(b.name),
      size: Number(b.size),
      folderId: b.folderId ?? null,
      chunkSize: b.chunkSize,
    }),
  );
}

async function putChunkHandler(req: Request, env: Env, uploadId: string, idx: number): Promise<Response> {
  await requireAuth(req, env);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, '空分片');
  return json(await putChunk(env, uploadId, idx, buf));
}

async function completeHandler(req: Request, env: Env, uploadId: string): Promise<Response> {
  await requireAuth(req, env);
  return json(await completeUpload(env, uploadId));
}

// ============ 下载 / 删除 ============
async function download(req: Request, env: Env, id: string): Promise<Response> {
  await requireAuth(req, env);
  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").bind(id).first<any>();
  if (!file) throw new HttpError(404, '文件不存在');
  return await serveFile(req, env, file);
}

/** /api/files/:id/play —— 内联播放：正确 Content-Type + inline，支持 Range 拖动 */
async function play(req: Request, env: Env, id: string): Promise<Response> {
  await requireAuth(req, env);
  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").bind(id).first<any>();
  if (!file) throw new HttpError(404, '文件不存在');
  return await serveFile(req, env, file, { inline: true });
}

/** 按扩展名猜 MIME；浏览器能直放的就 mp4(H.264/AAC)、webm 这几个 */
function mimeFor(name: string): string {
  const e = (name.split('.').pop() || '').toLowerCase();
  const m: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf',
  };
  return m[e] || 'application/octet-stream';
}

async function serveFile(req: Request, env: Env, file: any, opts?: { inline?: boolean }): Promise<Response> {
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
  if (start > end) throw new HttpError(416, 'Range 不合法');

  // 单请求最多拼 MAX_PARTS_PER_REQUEST 片（免费版 50 个外部子请求）。
  // 超过就把 end 夹到本请求能覆盖的最后一片末尾，返回 206 + Content-Range，
  // 由前端按 Content-Range 的 end 续拉下一段。
  const chunkRows = await getChunks(env, file.id);
  const capEnd = maxEndForRequest(chunkRows, start);
  if (end > capEnd) {
    end = capEnd;
    status = 206;
  }

  const body = await streamDownload(env, file.id, start, end, chunkRows);
  const inline = !!opts?.inline;
  const headers: Record<string, string> = {
    'Content-Type': inline ? mimeFor(file.name) : 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  };
  if (inline) headers['Cache-Control'] = 'private, max-age=3600';
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
  if (end < file.size - 1) headers['X-Segment-Next'] = String(end + 1);
  return new Response(body, { status, headers });
}

async function deleteFile(req: Request, env: Env, id: string): Promise<Response> {
  await requireAuth(req, env, 'admin');
  const { results: chunks } = await env.DB.prepare('SELECT * FROM chunks WHERE file_id = ?').bind(id).all<any>();
  const accounts = await store.listAccounts(env);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const c of chunks) {
    const acct = byId.get(c.account_id);
    if (acct) {
      try {
        await s3.s3Delete(acct, c.object_key);
      } catch {
        /* 单个分片删除失败不阻断，最多留垃圾 */
      }
      await store.reserveBytes(env, c.account_id, -c.size);
    }
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(id),
    env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id),
  ]);
  return json({ ok: true, removed: chunks.length });
}
