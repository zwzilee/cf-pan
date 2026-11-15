import type { Env } from './types';
import { cookie, getCookie, HttpError, json, Need, setSetting, getSetting } from './util';
import { hashPassword, signJWT, verifyJWT, verifyPassword } from './auth';
import { encryptSecret } from './crypto';
import * as store from './store';
import * as s3 from './s3';
import { completeUpload, getChunks, initUpload, maxEndForRequest, putChunk, streamDownload } from './chunk';
import { checkShareUsable, createShareToken, revokeShare, verifyShareToken } from './share';
import { checkLoginAllowed, clearLoginFailures, clientIp, MAX_ACCOUNT_FAILS, MAX_IP_FAILS, recordLoginFailure, WINDOW_SEC } from './ratelimit';
import { listVisits, logVisit, lockStatus, pruneVisits, summarizeVisits } from './visit';
import { clearAuthCookies, GUEST_TTL, publicSecret, readAccess, requireAdmin, requireAny, isManager } from './roles';
import { createApiToken, listApiTokens, revokeApiToken, setApiTokenEnabled } from './tokens';
import {
  deleteTgWebhook,
  getTgConfig,
  getTgWebhookInfo,
  newTgSecret,
  registerTgWebhook,
  saveTgConfig,
  handleTgUpdate,
} from './tg';
import {
  createSheet,
  deleteSheet,
  exportSheet,
  getSheet,
  listSheets,
  parseImport,
  renameSheet,
  saveSheet,
} from './sheet';
import {
  createDoc,
  deleteDoc,
  getDoc,
  listDocs,
  renderDocPage,
  renameDoc,
  saveDoc,
} from './doc';

const SESSION_TTL = 60 * 60 * 12; // 后台会话 12h

/** 本次请求解析出来的用户，给访问日志用 */
let currentUser: { uid: number; username?: string } | null = null;

/** 记一下这次请求是谁发的（uid 可能为空：前台访客 uid=0） */
function noteUser(a: { uid?: number; name?: string }) {
  currentUser = { uid: a.uid ?? 0, username: a.name };
}

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    currentUser = null;
    let res: Response;
    try {
      res = await route(req, env, ctx);
    } catch (e: any) {
      if (e instanceof Need || e instanceof HttpError) {
        res = json({ error: e.message }, { status: e.status });
      } else {
        res = json({ error: e?.message || String(e) }, { status: 500 });
      }
    }

    // 访问日志：IP 在鉴权前就读得到；写库异步做，不拖慢响应
    const p = new URL(req.url).pathname;
    if (env.LOG_VISITS !== '0' && p.startsWith('/api/') && !p.startsWith('/api/visits')) {
      const task = logVisit(env, req, res, currentUser);
      if (ctx?.waitUntil) ctx.waitUntil(task);
      else await task;
    }
    return res;
  },

  /** 定时任务：每 15 天清一次访问日志（wrangler.toml 的 [triggers] crons） */
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const days = Number(env.VISIT_KEEP_DAYS || (await getSetting(env, 'visit_keep_days')) || 15);
    const removed = await pruneVisits(env, days);
    await setSetting(env, 'last_prune', new Date().toISOString());
    console.log(`visits pruned: ${removed} rows older than ${days} days`);
    ctx.waitUntil(Promise.resolve());
  },
};

async function route(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const seg = p.split('/').filter(Boolean);

  // ================= 公开：分享 + 登录 =================
  if (seg[0] === 's' && seg[1]) return await publicShare(req, env, seg[1], seg[2]);
  if (p === '/api/public/info' && m === 'GET') return await publicInfo(req, env);
  if (p === '/api/login' && m === 'POST') return await login(req, env);
  if (p === '/api/front/login' && m === 'POST') return await frontLogin(req, env);
  if (p === '/api/password' && m === 'POST') return await changePassword(req, env);
  if (p === '/api/logout' && m === 'POST') {
    const res = json({ ok: true });
    for (const c of clearAuthCookies()) res.headers.append('Set-Cookie', c);
    return res;
  }

  // TG 上传渠道 webhook（Telegram 来调，靠 URL 里的 secret 认身份）
  if (seg[0] === 'api' && seg[1] === 'tg' && seg[2] === 'webhook' && seg[3] && m === 'POST')
    return await tgWebhook(req, env, seg[3], ctx);

  // ================= 身份 =================
  if (p === '/api/me' && m === 'GET') return await meHandler(req, env);
  if (p === '/api/health') return json({ ok: true, name: env.PUBLIC_APP_NAME || 'PAN R2' });

  // ================= 前台可读：目录树 / 文件 / 下载 / 播放 / 统计 =================
  if (p === '/api/stats' && m === 'GET') return await stats(req, env);
  if (p === '/api/tree' && m === 'GET') return await treeHandler(req, env);
  if (p === '/api/folders' && m === 'GET') return await listFolders(req, env);
  if (p === '/api/files' && m === 'GET') return await listFiles(req, env);
  if (p === '/api/sheets' && m === 'GET') return await listSheetsHandler(req, env);
  if (seg[0] === 'api' && seg[1] === 'sheets' && seg[2] && !seg[3] && m === 'GET')
    return await getSheetHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'sheets' && seg[2] && seg[3] === 'export' && m === 'GET')
    return await exportSheetHandler(req, env, seg[2]);
  if (p === '/api/docs' && m === 'GET') return await listDocsHandler(req, env);
  if (seg[0] === 'api' && seg[1] === 'docs' && seg[2] && m === 'GET')
    return await getDocHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'files' && seg[2] && seg[3] === 'download' && m === 'GET')
    return await download(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'files' && seg[2] && seg[3] === 'play' && m === 'GET')
    return await play(req, env, seg[2]);

  // ================= 管理员：目录 / 上传 / 删除 / 分享 =================
  if (p === '/api/folders' && m === 'POST') return await createFolder(req, env);
  if (seg[0] === 'api' && seg[1] === 'folders' && seg[2] && m === 'PATCH')
    return await renameFolder(req, env, Number(seg[2]));
  if (seg[0] === 'api' && seg[1] === 'folders' && seg[2] && m === 'DELETE')
    return await deleteFolder(req, env, Number(seg[2]));
  if (p === '/api/upload/init' && m === 'POST') return await initHandler(req, env);
  if (seg[0] === 'api' && seg[1] === 'upload' && seg[2] && seg[3] === 'chunk' && seg[4] && m === 'PUT')
    return await putChunkHandler(req, env, seg[2], Number(seg[4]));
  if (seg[0] === 'api' && seg[1] === 'upload' && seg[2] && seg[3] === 'complete' && m === 'POST')
    return await completeHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'files' && seg[2] && seg[3] === 'share' && m === 'POST')
    return await createShareHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'files' && seg[2] && m === 'DELETE') return await deleteFile(req, env, seg[2]);

  // ================= 管理员：在线表格 / 文档 =================
  if (p === '/api/sheets' && m === 'POST') return await createSheetHandler(req, env);
  if (seg[0] === 'api' && seg[1] === 'sheets' && seg[2] && seg[3] === 'save' && m === 'POST')
    return await saveSheetHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'sheets' && seg[2] && seg[3] === 'import' && m === 'POST')
    return await importSheetHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'sheets' && seg[2] && m === 'PATCH')
    return await renameSheetHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'sheets' && seg[2] && m === 'DELETE')
    return await deleteSheetHandler(req, env, seg[2]);
  if (p === '/api/docs' && m === 'POST') return await createDocHandler(req, env);
  if (seg[0] === 'api' && seg[1] === 'docs' && seg[2] && seg[3] === 'save' && m === 'POST')
    return await saveDocHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'docs' && seg[2] && m === 'PATCH') return await renameDocHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'docs' && seg[2] && m === 'DELETE') return await deleteDocHandler(req, env, seg[2]);

  // ================= 管理员：账号池 =================
  if (p === '/api/accounts' && m === 'GET') return await listAccountsHandler(req, env);
  if (p === '/api/accounts' && m === 'POST') return await createAccountHandler(req, env);
  if (seg[0] === 'api' && seg[1] === 'accounts' && seg[2] && seg[3] === 'test' && m === 'POST')
    return await testAccountHandler(req, env, Number(seg[2]));
  if (seg[0] === 'api' && seg[1] === 'accounts' && seg[2] && m === 'PATCH')
    return await updateAccountHandler(req, env, Number(seg[2]));
  if (seg[0] === 'api' && seg[1] === 'accounts' && seg[2] && m === 'DELETE')
    return await deleteAccountHandler(req, env, Number(seg[2]));

  // ================= 管理员：分享列表 =================
  if (p === '/api/shares' && m === 'GET') return await listSharesHandler(req, env);
  if (seg[0] === 'api' && seg[1] === 'shares' && seg[2] && m === 'DELETE')
    return await revokeShareHandler(req, env, seg[2]);

  // ================= 管理员：用户 / 前台密码 =================
  if (p === '/api/users' && m === 'GET') return await listUsers(req, env);
  if (p === '/api/users' && m === 'POST') return await createUser(req, env);
  if (seg[0] === 'api' && seg[1] === 'users' && seg[2] && m === 'PATCH')
    return await updateUser(req, env, Number(seg[2]));
  if (seg[0] === 'api' && seg[1] === 'users' && seg[2] && m === 'DELETE')
    return await deleteUser(req, env, Number(seg[2]));
  if (p === '/api/front/password' && m === 'POST') return await setFrontPassword(req, env);

  // ================= 管理员：API 令牌（无面板管理） =================
  if (p === '/api/tokens' && m === 'GET') return await listTokensHandler(req, env);
  if (p === '/api/tokens' && m === 'POST') return await createTokenHandler(req, env);
  if (seg[0] === 'api' && seg[1] === 'tokens' && seg[2] && m === 'DELETE')
    return await revokeTokenHandler(req, env, seg[2]);
  if (seg[0] === 'api' && seg[1] === 'tokens' && seg[2] && m === 'PATCH')
    return await updateTokenHandler(req, env, seg[2]);

  // ================= 管理员：TG 上传渠道 =================
  if (p === '/api/tg/config' && m === 'GET') return await tgConfigHandler(req, env);
  if (p === '/api/tg/config' && m === 'POST') return await tgSaveHandler(req, env, ctx);
  if (p === '/api/tg/info' && m === 'GET') return await tgInfoHandler(req, env);
  if (p === '/api/tg/register' && m === 'POST') return await tgRegisterHandler(req, env);
  if (p === '/api/tg/unregister' && m === 'POST') return await tgUnregisterHandler(req, env);

  // ================= 管理员：日志 / 锁 =================
  if (p === '/api/visits' && m === 'GET') return await visitsHandler(req, env);
  if (p === '/api/visits/prune' && m === 'POST') return await pruneHandler(req, env);
  if (p === '/api/locks' && m === 'GET') return await locksHandler(req, env);

  // ================= 静态前端 =================
  if (env.ASSETS && !p.startsWith('/api/')) return env.ASSETS.fetch(req);
  return json({ error: 'Not Found' }, { status: 404 });
}

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

/** 前台访问密码：admin 账号的密码。没设过就回 null（前端显示「去后台设一个」） */
async function frontPasswordHash(env: Env): Promise<string | null> {
  const r = await env.DB.prepare("SELECT pass_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").first<any>();
  return r?.pass_hash ?? null;
}

/** 后台登录：用户名 + 密码 → role=admin 才发 sid */
async function login(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as any;
  const username = String(b.username || '');
  const password = String(b.password || '');
  const ip = clientIp(req);
  await ensureBootstrap(env);

  const gate = await checkLoginAllowed(env, username, ip);
  if (gate.locked) throw new HttpError(429, lockMessage(env, gate.scope, gate.retryAfter));

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<any>();
  if (!user || !(await verifyPassword(password, user.pass_hash))) {
    throw new HttpError(401, await failMessage(env, username, ip));
  }
  if (user.role !== 'admin') {
    throw new HttpError(403, '这个账号是前台访客，请用前台入口登录');
  }

  await clearLoginFailures(env, username);
  currentUser = { uid: user.id, username: user.username };
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const token = await signJWT({ uid: user.id, role: 'admin', u: user.username, exp }, env.JWT_SECRET);
  return json(
    { ok: true, role: 'admin', user: { uid: user.id, name: user.username } },
    { headers: { 'Set-Cookie': cookie('sid', token, SESSION_TTL) } },
  );
}

/** 前台登录：一个访问密码就够，签发 90 天的 guest 凭证 */
async function frontLogin(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as any;
  const password = String(b.password || '');
  const ip = clientIp(req);
  const label = 'front'; // 前台密码共享，限流桶用固定标签，别让访客之间互相锁
  await ensureBootstrap(env);

  const spot = await frontPasswordHash(env);
  if (!spot) throw new HttpError(409, '还没设置前台访问密码，去后台「设置」里设一个');

  const gate = await checkLoginAllowed(env, label, ip);
  if (gate.locked) throw new HttpError(429, lockMessage(env, gate.scope, gate.retryAfter));

  if (!(await verifyPassword(password, spot))) throw new HttpError(401, await failMessage(env, label, ip));

  await clearLoginFailures(env, label);
  const exp = Math.floor(Date.now() / 1000) + GUEST_TTL;
  const token = await signJWT({ uid: 0, role: 'user', scope: 'read', exp }, publicSecret(env));
  return json(
    { ok: true, ok2: true, role: 'guest', exp },
    { headers: { 'Set-Cookie': cookie('guest', token, GUEST_TTL) } },
  );
}

function lockMessage(_env: Env, scope: 'account' | 'ip' | undefined, retryAfter: number): string {
  const mins = Math.max(1, Math.ceil(retryAfter / 60));
  return scope === 'ip'
    ? `这个网络试错太多（${MAX_IP_FAILS} 次/10 分钟），${mins} 分钟后再试`
    : `密码错误次数过多（${MAX_ACCOUNT_FAILS} 次），${mins} 分钟后再试`;
}

async function failMessage(env: Env, username: string, ip: string): Promise<string> {
  const { left, ipLeft } = await recordLoginFailure(env, username, ip);
  if (ipLeft <= 0) return `密码错误太多，这个网络已锁定 ${Math.round(WINDOW_SEC / 60)} 分钟`;
  if (left <= 0) return `密码错误次数过多，账号已锁定 ${Math.round(WINDOW_SEC / 60)} 分钟`;
  return `密码不对，还可试 ${Math.min(left, 3)} 次`;
}

/** 我是谁：返回身份 + 能干什么，前端据此渲染前台/后台两套壳 */
async function meHandler(req: Request, env: Env): Promise<Response> {
  const a = await readAccess(req, env);
  if (!a) return json({ ok: true, user: null, can: emptyCaps(), frontReady: !!(await frontPasswordHash(env)) });
  if (a.uid) currentUser = { uid: a.uid, username: a.name };

  const caps = emptyCaps();
  caps.read = true;
  if (isManager(a)) {
    caps.read = caps.write = caps.manage = caps.accounts = caps.users = caps.logs = true;
    caps.password = caps.shares = caps.tokens = caps.telegram = true;
  }
  return json({
    ok: true,
    user: {
      kind: a.kind,
      name: a.name || (a.kind === 'admin' ? '管理员' : a.kind === 'token' ? '令牌' : '访客'),
      uid: a.uid ?? 0,
    },
    can: caps,
    frontReady: !!(await frontPasswordHash(env)),
  });
}

function emptyCaps() {
  return {
    read: false,
    write: false,
    manage: false,
    accounts: false,
    users: false,
    logs: false,
    shares: false,
    password: false,
    tokens: false,
    telegram: false,
  };
}

/** 改管理员自己的密码：验旧密码 → 换新哈希 → 重发 sid */
async function changePassword(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  const b = (await req.json().catch(() => ({}))) as any;
  const oldPw = String(b.oldPassword || '');
  const newPw = String(b.newPassword || '');
  if (!newPw || newPw.length < 8) throw new HttpError(400, '新密码至少 8 位');
  if (!oldPw) throw new HttpError(400, '要填旧密码');

  noteUser(me);
  const ip = clientIp(req);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(me.uid).first<any>();
  if (!user) throw new HttpError(401, '会话用户不存在');

  const gate = await checkLoginAllowed(env, user.username, ip);
  if (gate.locked) throw new HttpError(429, lockMessage(env, gate.scope, gate.retryAfter));
  if (!(await verifyPassword(oldPw, user.pass_hash))) {
    throw new HttpError(403, await failMessage(env, user.username, ip));
  }

  const hash = await hashPassword(newPw);
  await env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(hash, me.uid).run();
  await clearLoginFailures(env, user.username);

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const token = await signJWT({ uid: user.id, role: 'admin', u: user.username, exp }, env.JWT_SECRET);
  return json({ ok: true }, { headers: { 'Set-Cookie': cookie('sid', token, SESSION_TTL) } });
}

// ============ 用户 / 前台密码 ============
async function listUsers(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const { results } = await env.DB.prepare(
    'SELECT id, username, role, front_enabled, created_at FROM users ORDER BY id',
  ).all<any>();
  return json({ users: results, frontReady: !!(await frontPasswordHash(env)) });
}

async function createUser(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!username || password.length < 6) throw new HttpError(400, '用户名要有，密码至少 6 位');
  const dup = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<any>();
  if (dup) throw new HttpError(409, '用户名已存在');

  const role = b.role === 'admin' ? 'admin' : 'user';
  const hash = await hashPassword(password);
  const r = await env.DB.prepare(
    'INSERT INTO users (username, pass_hash, role, front_enabled, created_at) VALUES (?, ?, ?, 1, ?)',
  )
    .bind(username, hash, role, new Date().toISOString())
    .run();
  return json({ ok: true, id: r.meta.last_row_id });
}

async function updateUser(req: Request, env: Env, id: number): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const sets: string[] = [];
  const vals: any[] = [];

  if ('front_enabled' in b) {
    sets.push('front_enabled = ?');
    vals.push(b.front_enabled ? 1 : 0);
  }
  if (b.password) {
    if (String(b.password).length < 6) throw new HttpError(400, '密码至少 6 位');
    sets.push('pass_hash = ?');
    vals.push(await hashPassword(String(b.password)));
  }
  if (b.role) {
    if (b.role !== 'admin' && b.role !== 'user') throw new HttpError(400, 'role 只能是 admin / user');
    // 不许把最后一个管理员降级
    if (b.role === 'user') {
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<any>();
      if (n && n.n <= 1) throw new HttpError(400, '至少要留一个管理员');
    }
    sets.push('role = ?');
    vals.push(b.role);
  }
  if (!sets.length) throw new HttpError(400, '没有可更新字段');
  vals.push(id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return json({ ok: true });
}

async function deleteUser(req: Request, env: Env, id: number): Promise<Response> {
  const me = await requireAdmin(req, env);
  if (me.uid === id) throw new HttpError(400, '不能删自己');
  const u = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<any>();
  if (!u) throw new HttpError(404, '用户不存在');
  if (u.role === 'admin') {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<any>();
    if (n && n.n <= 1) throw new HttpError(400, '至少要留一个管理员');
  }
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/** 设/改「前台访问密码」＝ 改 admin 账号口令（前台只认一个共享密码） */
async function setFrontPassword(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const pw = String(b.password || '');
  const oldPw = String(b.oldPassword || '');
  if (pw.length < 6) throw new HttpError(400, '前台密码至少 6 位');

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(me.uid).first<any>();
  if (!user) throw new HttpError(401, '会话用户不存在');
  // 改的不是「自己」那条口令时也要验一次旧密码，避免会话被借走就改密码
  if (oldPw && !(await verifyPassword(oldPw, user.pass_hash))) throw new HttpError(403, '当前管理员密码不对');

  await env.DB.prepare("UPDATE users SET pass_hash = ? WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)")
    .bind(await hashPassword(pw))
    .run();
  return json({ ok: true });
}

// ============ 访问日志 / 登录锁 ============
async function visitsHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') || 100);
  const offset = Number(url.searchParams.get('offset') || 0);
  const wantSummary = url.searchParams.get('summary') === '1';
  const rows = await listVisits(env, limit, offset);
  const summary = wantSummary ? await summarizeVisits(env, 1000) : [];
  return json({
    visits: rows,
    summary,
    ip: clientIp(req),
    country: (req as any).cf?.country ?? null,
    keepDays: Number((await getSetting(env, 'visit_keep_days')) || 15),
    lastPrune: await getSetting(env, 'last_prune'),
  });
}

async function pruneHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const days = Number(b.days || 15);
  const removed = await pruneVisits(env, days);
  await setSetting(env, 'last_prune', new Date().toISOString());
  if (b.days) await setSetting(env, 'visit_keep_days', String(days));
  return json({ ok: true, removed, days });
}

async function locksHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const url = new URL(req.url);
  const username = url.searchParams.get('u') || me.name || '';
  const ip = url.searchParams.get('ip') || clientIp(req);
  const st = await lockStatus(env, username, ip);
  return json({ ok: true, username, ip, maxAccount: MAX_ACCOUNT_FAILS, maxIp: MAX_IP_FAILS, ...st });
}

// ============ 统计 ============
async function stats(req: Request, env: Env): Promise<Response> {
  const me = await requireAny(req, env);
  if (me.uid) currentUser = { uid: me.uid, username: me.name };
  const acc = await env.DB.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(capacity_bytes),0) AS cap, COALESCE(SUM(used_bytes),0) AS used FROM accounts WHERE enabled = 1',
  ).first<any>();
  const files = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS size FROM files WHERE status = 'ready'",
  ).first<any>();
  const folders = await env.DB.prepare('SELECT COUNT(*) AS n FROM folders').first<any>();
  const blobs = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS size FROM blobs').first<any>();
  return json({
    accounts: acc.n,
    capacity: acc.cap,
    used: acc.used,
    files: files.n,
    filesSize: files.size,
    folders: folders.n,
    blobs: blobs.n,
    // 去重省下的量：所有文件名义体积 - 实际落盘字节
    dedupSaved: Math.max(0, (files.size || 0) - (acc.used || 0)),
  });
}

// ============ 目录 ============
async function listFolders(req: Request, env: Env): Promise<Response> {
  await requireAny(req, env);
  const { results } = await env.DB.prepare('SELECT id, parent_id, name, created_at FROM folders ORDER BY name').all();
  return json({ folders: results });
}

/** 一次给整个目录树 + 每层文件数/大小，前台靠它渲染侧栏 */
async function treeHandler(req: Request, env: Env): Promise<Response> {
  await requireAny(req, env);
  const { results: folders } = await env.DB.prepare('SELECT id, parent_id, name FROM folders ORDER BY name').all<any>();
  const { results: agg } = await env.DB.prepare(
    "SELECT folder_id, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files WHERE status = 'ready' GROUP BY folder_id",
  ).all<any>();
  const byFolder = new Map<number | null, { n: number; bytes: number }>();
  for (const a of agg) byFolder.set(a.folder_id, { n: a.n, bytes: a.bytes });

  const nodes = folders.map((f) => ({
    id: f.id,
    parent_id: f.parent_id,
    name: f.name,
    files: byFolder.get(f.id)?.n ?? 0,
    bytes: byFolder.get(f.id)?.bytes ?? 0,
  }));
  const root = byFolder.get(null) ?? { n: 0, bytes: 0 };
  return json({ folders: nodes, root: { files: root.n, bytes: root.bytes } });
}

async function createFolder(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, '目录名不能为空');
  const parentId = b.parentId ? Number(b.parentId) : null;
  const r = await env.DB.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)')
    .bind(parentId, name, new Date().toISOString())
    .run();
  return json({ id: r.meta.last_row_id });
}

async function renameFolder(req: Request, env: Env, id: number): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, '目录名不能为空');
  await env.DB.prepare('UPDATE folders SET name = ? WHERE id = ?').bind(name, id).run();
  return json({ ok: true });
}

/** 删目录：非空就拒绝，免得手滑连文件一起没了 */
async function deleteFolder(req: Request, env: Env, id: number): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const files = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id = ?').bind(id).first<any>();
  const sub = await env.DB.prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id = ?').bind(id).first<any>();
  if ((files?.n ?? 0) > 0 || (sub?.n ?? 0) > 0) throw new HttpError(409, '目录不是空的，先把里面的文件/子目录清掉');
  await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ============ 文件 ============
async function listFiles(req: Request, env: Env): Promise<Response> {
  await requireAny(req, env);
  const f = new URL(req.url).searchParams.get('folder');
  const folderId = f === null || f === '' || f === 'root' ? null : Number(f);
  const sql =
    folderId === null
      ? "SELECT id,name,size,chunks_count,folder_id,created_at FROM files WHERE status='ready' AND folder_id IS NULL ORDER BY created_at DESC"
      : "SELECT id,name,size,chunks_count,folder_id,created_at FROM files WHERE status='ready' AND folder_id = ? ORDER BY created_at DESC";
  const stmt = folderId === null ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(folderId);
  const { results } = await stmt.all();
  return json({ files: results, folderId });
}

// ============ 账号池（管理员） ============
async function listAccountsHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
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
  const me = await requireAdmin(req, env);
  noteUser(me);
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
  const me = await requireAdmin(req, env);
  noteUser(me);
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
  const me = await requireAdmin(req, env);
  noteUser(me);
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
  const me = await requireAdmin(req, env);
  noteUser(me);
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks WHERE account_id = ?').bind(id).first<any>();
  if (used && used.n > 0) throw new HttpError(400, '该账号下还有分片，先删除对应文件再移除');
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ============ 分享 ============
async function createShareHandler(req: Request, env: Env, fileId: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
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
  const me = await requireAdmin(req, env);
  noteUser(me);
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
  const me = await requireAdmin(req, env);
  noteUser(me);
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

/** /s/<token> —— 浏览器来就回页面，带 ?dl=1 或 /download 就回文件 */
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
<style>
:root{--bg:#0b0e14;--card:#131823;--line:#232b3a;--fg:#e8eefc;--mut:#8b97ad;--accent:#4f8cff;--ok:#2ec27e}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(1200px 600px at 50% -10%,#1a2440 0%,var(--bg) 60%);color:var(--fg);
  font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.c{background:linear-gradient(180deg,#161d2b,#121722);border:1px solid var(--line);border-radius:18px;
  padding:34px 30px 26px;max-width:440px;width:calc(100% - 36px);text-align:center;
  box-shadow:0 24px 60px -20px rgba(0,0,0,.8)}
.ico{width:52px;height:52px;margin:0 auto 16px;border-radius:14px;display:grid;place-items:center;
  background:linear-gradient(135deg,#2b4a8f,#1b2b4d);font-size:24px}
h1{font-size:15px;word-break:break-all;margin:0 0 8px;line-height:1.5}
.m{color:var(--mut);font-size:12px;margin-bottom:22px}
a.btn{display:block;background:linear-gradient(180deg,#5b96ff,#3f7bf0);color:#fff;text-decoration:none;
  padding:12px;border-radius:10px;font-size:14px;font-weight:600;box-shadow:0 8px 20px -8px #3f7bf0}
a.btn:hover{filter:brightness(1.08)}
.f{margin-top:16px;color:#5f6b80;font-size:11px;line-height:1.8}
</style></head>
<body><div class="c"><div class="ico">🗂</div><h1>${esc(name)}</h1>
<div class="m">${gb(size)} · ${remaining >= 0 ? `剩余 ${remaining} 次下载` : '不限次数'}</div>
<a class="btn" href="/s/${token}?dl=1">下载文件</a>
<div class="f">有效期至 ${new Date(exp * 1000).toLocaleString('zh-CN')}<br>由 PAN R2 分享</div>
</div></body></html>`;
}

// ============ 分片上传（管理员） ============
async function initHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
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
  await requireAdmin(req, env);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, '空分片');
  return json(await putChunk(env, uploadId, idx, buf));
}

async function completeHandler(req: Request, env: Env, uploadId: string): Promise<Response> {
  await requireAdmin(req, env);
  return json(await completeUpload(env, uploadId));
}

// ============ 下载 / 播放 / 删除 ============
async function download(req: Request, env: Env, id: string): Promise<Response> {
  await requireAny(req, env);
  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").bind(id).first<any>();
  if (!file) throw new HttpError(404, '文件不存在');
  return await serveFile(req, env, file);
}

/** /api/files/:id/play —— 内联播放：正确 Content-Type + inline，支持 Range 拖动 */
async function play(req: Request, env: Env, id: string): Promise<Response> {
  await requireAny(req, env);
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
    pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
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
  const me = await requireAdmin(req, env);
  noteUser(me);
  const { results: chunks } = await env.DB.prepare('SELECT * FROM chunks WHERE file_id = ?').bind(id).all<any>();
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

  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE file_id = ?').bind(id),
    env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id),
  ]);
  return json({ ok: true, removed: chunks.length, blobsDeleted: toDelete.size });
}

// ============ 在线表格 ============
function folderOf(url: URL): number | null {
  const f = url.searchParams.get('folder');
  if (f === null || f === '' || f === 'root') return null;
  const n = Number(f);
  return Number.isFinite(n) ? n : null;
}

async function listSheetsHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAny(req, env);
  if (me.uid) noteUser(me);
  return json({ sheets: await listSheets(env, folderOf(new URL(req.url))) });
}

async function getSheetHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAny(req, env);
  if (me.uid) noteUser(me);
  const sheet = await getSheet(env, id);
  if (!sheet) throw new HttpError(404, '表格不存在');
  return json({ sheet });
}

async function createSheetHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const r = await createSheet(env, {
    name: String(b.name || '未命名表格'),
    rows: b.rows,
    cols: b.cols,
    folderId: b.folderId ?? null,
  });
  return json({ ok: true, ...r });
}

async function saveSheetHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const n = await saveSheet(env, id, { rows: b.rows, cols: b.cols, cells: b.cells || [] });
  return json({ ok: true, saved: n });
}

async function importSheetHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const text = String(b.text || '');
  const parsed = parseImport(text);
  const n = await saveSheet(env, id, parsed);
  return json({ ok: true, saved: n, rows: parsed.rows, cols: parsed.cols });
}

async function renameSheetHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, '名字不能为空');
  await renameSheet(env, id, name);
  return json({ ok: true });
}

async function deleteSheetHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  await deleteSheet(env, id);
  return json({ ok: true });
}

async function exportSheetHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAny(req, env);
  if (me.uid) noteUser(me);
  const sheet = await getSheet(env, id);
  if (!sheet) throw new HttpError(404, '表格不存在');
  const tsv = exportSheet(sheet);
  return new Response('\uFEFF' + tsv, {
    headers: {
      'Content-Type': 'text/tab-separated-values; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(sheet.name.replace(/\.[^.]+$/, '') + '.tsv')}`,
    },
  });
}

// ============ 在线文档（文本 / Markdown / 代码） ============
async function listDocsHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAny(req, env);
  if (me.uid) noteUser(me);
  return json({ docs: await listDocs(env, folderOf(new URL(req.url))) });
}

async function getDocHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAny(req, env);
  if (me.uid) noteUser(me);
  const doc = await getDoc(env, id);
  if (!doc) throw new HttpError(404, '文档不存在');

  // ?raw=1 → 纯文本（编辑器要）；?view=1 → 渲染出来的 HTML 页
  const url = new URL(req.url);
  if (url.searchParams.get('raw') === '1') {
    return new Response(doc.content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      },
    });
  }
  if (url.searchParams.get('view') === '1') {
    return new Response(renderDocPage(doc.name, doc.content, doc.updated_at), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return json({ doc });
}

async function createDocHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const r = await createDoc(env, {
    name: String(b.name || '未命名.md'),
    folderId: b.folderId ?? null,
    content: b.content ? String(b.content) : '',
  });
  return json({ ok: true, ...r });
}

async function saveDocHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  return json(await saveDoc(env, id, String(b.content ?? '')));
}

async function renameDocHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, '名字不能为空');
  await renameDoc(env, id, name);
  return json({ ok: true });
}

async function deleteDocHandler(req: Request, env: Env, id: string): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  await deleteDoc(env, id);
  return json({ ok: true });
}

// ============ API 令牌（无面板管理） ============
async function listTokensHandler(req: Request, env: Env): Promise<Response> {
  await requireAdmin(req, env);
  return json({ tokens: await listApiTokens(env) });
}

async function createTokenHandler(req: Request, env: Env): Promise<Response> {
  const me = await requireAdmin(req, env);
  noteUser(me);
  const b = (await req.json().catch(() => ({}))) as any;
  const scopes = Array.isArray(b.scopes) ? b.scopes : String(b.scopes || 'manage').split(/[\s,]+/);
  const t = await createApiToken(env, b.name, scopes, me.name || 'admin');
  return json({ ok: true, token: t.token, item: { id: t.id, name: t.name, prefix: t.prefix, scopes: t.scopes } });
}

async function revokeTokenHandler(req: Request, env: Env, id: string): Promise<Response> {
  await requireAdmin(req, env);
  return json({ ok: await revokeApiToken(env, id) });
}

async function updateTokenHandler(req: Request, env: Env, id: string): Promise<Response> {
  await requireAdmin(req, env);
  const b = (await req.json().catch(() => ({}))) as any;
  if (typeof b.enabled === 'boolean') await setApiTokenEnabled(env, id, b.enabled);
  return json({ ok: true });
}

// ============ Telegram 上传渠道 ============
function maskToken(t: string): string {
  if (!t) return '';
  const i = t.indexOf(':');
  return i > 0 ? t.slice(0, i) + ':***' + t.slice(-4) : t.slice(0, 4) + '***';
}

async function tgConfigView(env: Env) {
  const c = await getTgConfig(env);
  return {
    botTokenMasked: maskToken(c.botToken),
    botTokenSet: !!c.botToken,
    secret: c.secret,
    allowed: c.allowed,
    folderId: c.folderId,
    apiBase: c.apiBase,
    customBase: c.apiBase !== 'https://api.telegram.org',
    maxBytes: c.maxBytes,
    webhookUrl: (await getSetting(env, 'tg_webhook_url')) || '',
    lastAt: (await getSetting(env, 'tg_last_at')) || '',
    cloudMax: 20 * 1024 * 1024,
    localMax: 2000 * 1024 * 1024,
  };
}

async function tgConfigHandler(req: Request, env: Env): Promise<Response> {
  await requireAdmin(req, env);
  return json({ ok: true, config: await tgConfigView(env) });
}

async function tgSaveHandler(req: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  await requireAdmin(req, env);
  const b = (await req.json().catch(() => ({}))) as any;
  const patch: any = {};
  if (typeof b.botToken === 'string' && b.botToken.trim()) patch.botToken = b.botToken.trim();
  if (b.clearToken) patch.botToken = '';
  if (typeof b.allowedRaw === 'string') patch.allowedRaw = b.allowedRaw;
  if (b.folderId !== undefined) patch.folderId = b.folderId === '' || b.folderId === null ? null : Number(b.folderId);
  if (typeof b.apiBase === 'string') patch.apiBase = b.apiBase;
  if (b.maxBytes !== undefined) patch.maxBytes = Number(b.maxBytes) || 0;
  if (b.regenSecret) patch.secret = newTgSecret();
  let cfg = await saveTgConfig(env, patch);
  if (!cfg.secret) cfg = await saveTgConfig(env, { secret: newTgSecret() });
  return json({ ok: true, config: await tgConfigView(env) });
}

async function tgInfoHandler(req: Request, env: Env): Promise<Response> {
  await requireAdmin(req, env);
  return json({ ok: true, info: await getTgWebhookInfo(env), config: await tgConfigView(env) });
}

async function tgRegisterHandler(req: Request, env: Env): Promise<Response> {
  await requireAdmin(req, env);
  let cfg = await getTgConfig(env);
  if (!cfg.secret) cfg = await saveTgConfig(env, { secret: newTgSecret() });
  const origin = new URL(req.url).origin;
  const r = await registerTgWebhook(env, origin);
  return json({ ok: true, url: r.url, info: await getTgWebhookInfo(env), config: await tgConfigView(env) });
}

async function tgUnregisterHandler(req: Request, env: Env): Promise<Response> {
  await requireAdmin(req, env);
  await deleteTgWebhook(env);
  return json({ ok: true, config: await tgConfigView(env) });
}

async function tgWebhook(req: Request, env: Env, secret: string, ctx?: ExecutionContext): Promise<Response> {
  const cfg = await getTgConfig(env);
  if (!cfg.secret || secret !== cfg.secret) return json({ ok: false, error: 'bad secret' }, { status: 403 });
  const update = await req.json().catch(() => null);
  if (!update) return json({ ok: true });
  const task = handleTgUpdate(env, update).catch((e: any) =>
    console.log('tg handle error: ' + (e?.message || String(e))),
  );
  if (ctx?.waitUntil) ctx.waitUntil(task);
  else await task;
  return json({ ok: true });
}
