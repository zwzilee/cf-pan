import type { Env } from './types';
import { getSetting, setSetting } from './util';
import { initUpload, putChunk, completeUpload, MIN_CHUNK, MAX_CHUNK } from './chunk';
import { pruneVisits } from './visit';

/**
 * Telegram 上传渠道：给自己的 Telegram 机器人发文件 → 自动落进网盘。
 *
 * 玩法：
 *   1. @BotFather 建个 bot，拿 token；后台「TG 上传」页填进去。
 *   2. 后台点「注册 Webhook」，把 https://<worker>/api/tg/webhook/<secret> 设给 Telegram。
 *   3. 给 bot 发文件（document/video/audio/voice/photo），消息一到就落盘。
 *
 * ⚠️ 20MB 的来路：Telegram **云** Bot API 的 getFile 只允许下载 20MB 以内的文件
 *    （上传是 50MB，但那是「bot 发出去」，跟「bot 收下来」不是一回事）。
 *    用户发 1.9GB 给 bot 是能发出去的（Telegram 客户端自己传到 DC，bot 只拿到 file_id），
 *    但 bot 调 getFile 就会被拒 —— 所以这条渠道在云 API 下上限就是 20MB。
 *
 * 想突破 20MB：自己跑官方 Local Bot API Server（--local 模式），
 *    下载不限大小、上传到 2000MB。跑起来之后把它的 HTTPS 地址填到「自定义 Bot API 地址」，
 *    本模块所有请求（setWebhook / getFile / 下载）都会改走那个地址。
 */

export const TG_CLOUD_MAX = 20 * 1024 * 1024; // 云 API：getFile 下载上限
export const TG_LOCAL_MAX = 2000 * 1024 * 1024; // 本地 Bot API：上传上限，下载不限
export const DEFAULT_API_BASE = 'https://api.telegram.org';

export interface TgConfig {
  botToken: string;
  secret: string;
  /** 本地 Bot API 的静态文件服务基址（如 https://dsh.dante.us.ci/tgfile）；空 = 用云 /file 接口 */
  fileBase: string;
  /** 访问 fileBase 需要的请求头密钥（X-Tgfile-Secret） */
  fileSecret: string;
  /** 允许的 chat id；空 = 不限制（任何能给 bot 发消息的人都能传） */
  allowed: string[];
  /** 落到哪个目录；null = 根目录 */
  folderId: number | null;
  /** 自定义 Bot API 地址（本地 Bot API Server），空 = 官方云 API */
  apiBase: string;
  /** 单个文件上限；0 = 按 apiBase 自动（云 20MB / 本地 2000MB） */
  maxBytes: number;
  /** 管理员 chat id 列表：这些 chat 能用 /stats /channels /prune */
  admins: string[];
}

function isCustomBase(base: string): boolean {
  return !!base && base.replace(/\/+$/, '') !== DEFAULT_API_BASE;
}

export async function getTgConfig(env: Env): Promise<TgConfig> {
  const [token, secret, allowed, folder, base, max, admins, fileBase, fileSecret] = await Promise.all([
    getSetting(env, 'tg_bot_token'),
    getSetting(env, 'tg_secret'),
    getSetting(env, 'tg_allowed'),
    getSetting(env, 'tg_folder'),
    getSetting(env, 'tg_api_base'),
    getSetting(env, 'tg_max_bytes'),
    getSetting(env, 'tg_admins'),
    getSetting(env, 'tg_file_base'),
    getSetting(env, 'tg_file_secret'),
  ]);
  const apiBase = (base || '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
  const autoMax = isCustomBase(apiBase) ? TG_LOCAL_MAX : TG_CLOUD_MAX;
  const n = Number(max || 0);
  return {
    botToken: (token || '').trim(),
    secret: (secret || '').trim(),
    allowed: String(allowed || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    folderId: folder && /^\d+$/.test(String(folder)) ? Number(folder) : null,
    apiBase,
    maxBytes: n > 0 ? Math.min(n, TG_LOCAL_MAX) : autoMax,
    admins: String(admins || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    fileBase: (fileBase || '').trim().replace(/\/+$/, ''),
    fileSecret: (fileSecret || '').trim(),
  };
}

export async function saveTgConfig(
  env: Env,
  patch: Partial<TgConfig> & { allowedRaw?: string; adminsRaw?: string },
): Promise<TgConfig> {
  if (patch.botToken !== undefined) await setSetting(env, 'tg_bot_token', patch.botToken.trim());
  if (patch.secret !== undefined) await setSetting(env, 'tg_secret', patch.secret.trim());
  if (patch.allowedRaw !== undefined) await setSetting(env, 'tg_allowed', patch.allowedRaw.trim());
  else if (patch.allowed !== undefined) await setSetting(env, 'tg_allowed', patch.allowed.join(','));
  if (patch.adminsRaw !== undefined) await setSetting(env, 'tg_admins', patch.adminsRaw.trim());
  else if (patch.admins !== undefined) await setSetting(env, 'tg_admins', patch.admins.join(','));
  if (patch.folderId !== undefined) await setSetting(env, 'tg_folder', patch.folderId == null ? '' : String(patch.folderId));
  if (patch.apiBase !== undefined)
    await setSetting(env, 'tg_api_base', patch.apiBase.trim().replace(/\/+$/, ''));
  if (patch.maxBytes !== undefined) await setSetting(env, 'tg_max_bytes', String(patch.maxBytes || 0));
  if ((patch as any).fileBase !== undefined) await setSetting(env, 'tg_file_base', String((patch as any).fileBase).trim().replace(/\/+$/, ''));
  if ((patch as any).fileSecret !== undefined) await setSetting(env, 'tg_file_secret', String((patch as any).fileSecret).trim());
  return getTgConfig(env);
}

export function newTgSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 调 Telegram Bot API（GET，带 query）。base 可指向本地 Bot API Server。 */
export async function tgApi(
  botToken: string,
  method: string,
  params: Record<string, string | number> = {},
  base: string = DEFAULT_API_BASE,
): Promise<any> {
  const u = new URL(`${base.replace(/\/+$/, '')}/bot${botToken}/${method}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u.toString());
  const j: any = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!j.ok) throw new Error(`Telegram ${method} 失败：${j.description || r.status}`);
  return j.result;
}

export async function registerTgWebhook(env: Env, origin: string): Promise<any> {
  const cfg = await getTgConfig(env);
  if (!cfg.botToken) throw new Error('还没填 bot token');
  if (!cfg.secret) throw new Error('还没生成 Webhook secret');
  const url = `${origin.replace(/\/$/, '')}/api/tg/webhook/${cfg.secret}`;
  const r = await tgApi(cfg.botToken, 'setWebhook', {
    url,
    allowed_updates: JSON.stringify(['message', 'channel_post']),
    drop_pending_updates: 'true',
  }, cfg.apiBase);
  await setSetting(env, 'tg_webhook_url', url);
  return { url, result: r };
}

export async function getTgWebhookInfo(env: Env): Promise<any> {
  const cfg = await getTgConfig(env);
  if (!cfg.botToken) return { configured: false };
  try {
    const info = await tgApi(cfg.botToken, 'getWebhookInfo', {}, cfg.apiBase);
    const me = await tgApi(cfg.botToken, 'getMe', {}, cfg.apiBase).catch(() => null);
    return {
      configured: true,
      url: info.url || '',
      pending: info.pending_update_count || 0,
      lastError: info.last_error_message || '',
      bot: me?.username ? '@' + me.username : '',
      customBase: isCustomBase(cfg.apiBase),
    };
  } catch (e: any) {
    return { configured: true, error: e?.message || String(e) };
  }
}

export async function deleteTgWebhook(env: Env): Promise<any> {
  const cfg = await getTgConfig(env);
  if (!cfg.botToken) throw new Error('还没填 bot token');
  await tgApi(cfg.botToken, 'deleteWebhook', { drop_pending_updates: 'true' }, cfg.apiBase);
  await setSetting(env, 'tg_webhook_url', '');
  return { ok: true };
}

function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let x = Number(n) || 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i++;
  }
  return (i ? x.toFixed(x < 10 ? 2 : 1) : x) + ' ' + u[i];
}

/* ------------------------- 入库任务进度（面板实时展示用） ------------------------- */

export interface TgJob {
  id: string;
  chat_id: string | null;
  name: string;
  size: number;
  phase: string; // queued / downloading / uploading / done / failed
  bytes_done: number;
  chunks_done: number;
  chunks_total: number;
  upload_id: string | null;
  file_id: string | null;
  error: string | null;
  dl_url?: string | null;
  file_base?: string | null;
  file_secret?: string | null;
  rate_bps?: number | null;
  created_at: string;
  updated_at: string;
}

function newJobId(): string {
  return 'tj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export async function createJob(env: Env, chatId: string, name: string, size: number): Promise<string> {
  const id = newJobId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO tg_jobs (id, chat_id, name, size, phase, bytes_done, chunks_done, chunks_total, created_at, updated_at) VALUES (?,?,?,?,?,0,0,0,?,?)',
  ).bind(id, chatId, name, size, 'queued', now, now).run();
  return id;
}

export async function updateJob(env: Env, id: string, patch: Partial<TgJob>): Promise<void> {
  const cols: string[] = [];
  const vals: any[] = [];
  for (const k of ['phase', 'bytes_done', 'chunks_done', 'chunks_total', 'upload_id', 'file_id', 'error', 'dl_url', 'file_base', 'file_secret', 'rate_bps'] as (keyof TgJob)[]) {
    if (patch[k] !== undefined) { cols.push(`${k} = ?`); vals.push(patch[k]); }
  }
  cols.push('updated_at = ?'); vals.push(new Date().toISOString());
  vals.push(id);
  await env.DB.prepare(`UPDATE tg_jobs SET ${cols.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function listJobs(env: Env, limit = 50): Promise<TgJob[]> {
  // 同一个文件（chat_id+name+size）多次重试/续传只会产生多条 job 行；
  // 这里按「每个文件只保留最近一条」去重，历史表格不再出现重复格子。
  const r = await env.DB.prepare(
    `SELECT * FROM tg_jobs t
     WHERE t.created_at = (
       SELECT MAX(x.created_at) FROM tg_jobs x
       WHERE x.chat_id = t.chat_id AND x.name = t.name AND x.size = t.size
     )
     ORDER BY t.created_at DESC LIMIT ?`,
  ).bind(limit).all<any>();
  return (r.results || []) as TgJob[];
}

export async function jobStats(env: Env): Promise<{ queued: number; active: number; done: number; failed: number; total: number; bytesDone: number }> {
  // 统计同样按「每个文件一条」去重，避免重试/续传把计数和累计入库撑虚。
  const rows = await env.DB.prepare(
    `SELECT t.phase, t.size, t.bytes_done FROM tg_jobs t
     WHERE t.created_at = (
       SELECT MAX(x.created_at) FROM tg_jobs x
       WHERE x.chat_id = t.chat_id AND x.name = t.name AND x.size = t.size
     )`,
  ).all<any>();
  const rs = (rows.results || []) as any[];
  const g = (p: string) => rs.filter((x) => x.phase === p).length;
  const total = rs.length;
  // 累计入库 = 所有已完成文件的真实大小之和（bytes_done 在 done 时不一定是整个文件，用 size 更准）
  const bytesDone = rs.filter((x) => x.phase === 'done').reduce((a, x) => a + Number(x.size || 0), 0);
  return {
    queued: g('queued'),
    active: g('downloading') + g('uploading'),
    done: g('done'),
    failed: g('failed'),
    total,
    bytesDone,
  };
}


interface Picked {
  fileId: string;
  name: string;
  size: number;
  mime: string | null;
  messageId?: number;
}
function pickFile(msg: any): Picked | null {
  const mid = msg.message_id;
  if (msg.document) {
    const d = msg.document;
    return { fileId: d.file_id, name: d.file_name || `document_${msg.message_id}`, size: d.file_size || 0, mime: d.mime_type || null, messageId: mid };
  }
  if (msg.video) {
    const v = msg.video;
    return { fileId: v.file_id, name: v.file_name || `video_${msg.message_id}.mp4`, size: v.file_size || 0, mime: v.mime_type || 'video/mp4', messageId: mid };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { fileId: a.file_id, name: a.file_name || `audio_${msg.message_id}.mp3`, size: a.file_size || 0, mime: a.mime_type || 'audio/mpeg', messageId: mid };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { fileId: v.file_id, name: `voice_${msg.message_id}.ogg`, size: v.file_size || 0, mime: v.mime_type || 'audio/ogg', messageId: mid };
  }
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { fileId: p.file_id, name: `photo_${msg.message_id}.jpg`, size: p.file_size || 0, mime: 'image/jpeg', messageId: mid };
  }
  return null;
}

/** 处理一条 Telegram update；返回给 Telegram 的响应体 */
/** 找（或建）<parent>/<chatId> 目录，返回目录 id */
async function ensureChatFolder(env: Env, parentId: number | null, chatId: string): Promise<number> {
  const name = String(chatId || 'unknown');
  const row = parentId == null
    ? await env.DB.prepare('SELECT id FROM folders WHERE parent_id IS NULL AND name = ?').bind(name).first<any>()
    : await env.DB.prepare('SELECT id FROM folders WHERE parent_id = ? AND name = ?').bind(parentId, name).first<any>();
  if (row?.id) return Number(row.id);
  const r = await env.DB.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)')
    .bind(parentId, name, new Date().toISOString())
    .run();
  return Number(r.meta.last_row_id);
}

export async function handleTgUpdate(env: Env, update: any): Promise<any> {
  const cfg = await getTgConfig(env);
  const msg = update?.message || update?.channel_post;
  if (!msg) return { ok: true, skipped: 'no message' };
  const chatId = String(msg.chat?.id ?? '');

  const reply = async (text: string) => {
    if (!cfg.botToken) return;
    try {
      await tgApi(cfg.botToken, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: 'true' }, cfg.apiBase);
    } catch {
      /* 回不了就算了 */
    }
  };

  const cmdHelp = (admin: boolean) => {
    const lines = [
      '把这个聊天里的文件直接存进网盘：文档 / 视频 / 音频 / 图片。',
      '',
      '用户命令：',
      '/id —— 看自己的 Chat ID',
      '/me —— 我落在哪个通道、哪个目录',
      '/files —— 我这个目录里最近的 10 个文件',
      '/usage —— 网盘总用量',
      '/help —— 这份说明',
    ];
    if (admin)
      lines.push('', '管理员命令：', '/stats —— 账号池与总用量', '/channels —— 通道列表', '/prune —— 清理 15 天前的访问日志');
    return lines.join('\n');
  };

  // ---------------- 机器人命令 ----------------
  const text = String(msg.text || msg.caption || '').trim();
  const m0 = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?/);
  const cmd = m0 ? m0[1].toLowerCase() : '';
  const isAdmin = !!chatId && cfg.admins.includes(chatId);
  const chans = await listChannels(env);
  const chan = chans.find((c) => c.enabled && c.allowed.includes(chatId)) || null;

  if (cmd) {
    const done = (extra: any = {}) => ({ ok: true, cmd, ...extra });
    if (cmd === 'start' || cmd === 'help') { await reply(cmdHelp(isAdmin)); return done(); }
    if (cmd === 'id' || cmd === 'whoami') { await reply('你的 Chat ID：' + chatId); return done(); }
    if (cmd === 'usage' || cmd === 'quota') {
      const a = await env.DB.prepare('SELECT COALESCE(SUM(used_bytes),0) AS used, COALESCE(SUM(capacity_bytes),0) AS cap, COUNT(*) AS n FROM accounts WHERE enabled = 1').first<any>();
      const f = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS s FROM files').first<any>();
      await reply('网盘用量：' + fmtBytes(Number(a.used)) + ' / ' + fmtBytes(Number(a.cap)) + '（启用账号 ' + a.n + ' 个）\n文件 ' + f.n + ' 个，共 ' + fmtBytes(Number(f.s)));
      return done();
    }
    if (isAdmin && cmd === 'stats') {
      const a = await env.DB.prepare('SELECT COALESCE(SUM(used_bytes),0) AS used, COALESCE(SUM(capacity_bytes),0) AS cap, COUNT(*) AS n FROM accounts').first<any>();
      const off = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE enabled = 0').first<any>();
      const f = await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<any>();
      const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<any>();
      await reply('【管理员】\n账号 ' + a.n + ' 个（停用 ' + off.n + '）\n用量 ' + fmtBytes(Number(a.used)) + ' / ' + fmtBytes(Number(a.cap)) + '\n文件 ' + f.n + ' 个\n用户 ' + u.n + ' 个');
      return done();
    }
    if (isAdmin && cmd === 'channels') {
      if (!chans.length) { await reply('还没有通道。'); return done(); }
      const rows: string[] = [];
      for (const c of chans) {
        const fn = c.folder_id == null ? '（根目录）' : (((await env.DB.prepare('SELECT name FROM folders WHERE id = ?').bind(c.folder_id).first<any>()) || {}).name || '-');
        rows.push((c.enabled ? '✅' : '⏸') + ' ' + (c.bot_username || c.name) + ' → ' + fn + ' ｜白名单 ' + c.allowed.length + ' 个');
      }
      await reply('通道 ' + chans.length + ' 个：\n' + rows.join('\n'));
      return done();
    }
    if (isAdmin && cmd === 'prune') {
      const n = await pruneVisits(env, 15);
      await reply('已清理 ' + n + ' 条 15 天前的访问日志。');
      return done();
    }
    if (cmd === 'me' || cmd === 'who' || cmd === 'files' || cmd === 'ls') {
      if (!chan) { await reply('这个 Chat ID 不在任何通道的白名单里：' + chatId); return done({ skipped: 'no channel' }); }
      const folderId = await ensureChatFolder(env, chan.folder_id, chatId);
      if (cmd === 'me' || cmd === 'who') {
        const pn = chan.folder_id == null ? '（根目录）' : (((await env.DB.prepare('SELECT name FROM folders WHERE id = ?').bind(chan.folder_id).first<any>()) || {}).name || '-');
        await reply('通道：' + chan.name + '\n落盘目录：' + pn + ' / ' + chatId);
        return done();
      }
      const list = await env.DB.prepare('SELECT name, size FROM files WHERE folder_id = ? ORDER BY id DESC LIMIT 10').bind(folderId).all<any>();
      const rs = (list.results || []) as any[];
      if (!rs.length) { await reply('这个目录里还没有文件。'); return done(); }
      await reply('最近 ' + rs.length + ' 个文件：\n' + rs.map((x: any) => '· ' + x.name + '（' + fmtBytes(Number(x.size)) + '）').join('\n'));
      return done();
    }
    await reply('不认识的命令。发 /help 看看能做什么。');
    return done({ skipped: 'unknown cmd' });
  }

  if (!chan) {
    if (!chans.length) {
      await reply(`还没有 TG 通道。先在后台上建一个「TG 文件夹」，再把 Chat ID ${chatId} 加进它的白名单。`);
    } else {
      await reply(`这个 Chat ID 不在任何通道的白名单里：${chatId}`);
    }
    return { ok: true, skipped: 'no channel: ' + chatId };
  }

  const picked = pickFile(msg);
  if (!picked) {
    await reply(cmdHelp(isAdmin));
    return { ok: true, skipped: 'no file' };
  }
  if (picked.size && picked.size > cfg.maxBytes) {
    const hint = isCustomBase(cfg.apiBase)
      ? `本地 Bot API 上限 ${fmtBytes(cfg.maxBytes)}。`
      : `Telegram 云 Bot API 的 getFile 只能下载 20MB 以内的文件（这是官方的限制，不是网盘的）。\n想传更大的：自己跑 Local Bot API Server，把地址填进「自定义 Bot API 地址」，上限就到 2GB。\n眼下这份请用网页面板分片上传。`;
    await reply(`「${picked.name}」${fmtBytes(picked.size)}，超出可下载上限。\n${hint}`);
    return { ok: true, skipped: 'too big: ' + picked.size };
  }

  // 开始处理前先回执，让用户立刻知道"收到了、在存"
  try {
    await reply(`📥 收到「${picked.name}」（${fmtBytes(picked.size || 0)}），正在存入网盘…`);
  } catch {
    /* ignore */
  }

  // 建一条进度任务，面板能实时看到 queued → downloading → uploading → done
  // 若同 chat+同名+同大小还有一个未完成的 job（续传场景），复用它，避免面板出现一堆重复格子
  let jobId = '';
  try {
    const existJob = await env.DB.prepare(
      `SELECT id FROM tg_jobs WHERE chat_id=? AND name=? AND size=? AND phase IN ('queued','downloading','uploading','completing') ORDER BY created_at DESC LIMIT 1`,
    ).bind(chatId, picked.name, picked.size || 0).first<any>();
    if (existJob?.id) jobId = String(existJob.id);
  } catch { /* ignore */ }
  if (!jobId) jobId = await createJob(env, chatId, picked.name, picked.size || 0).catch(() => '');

  const folderLabel = async (): Promise<string> => {
    const fid = await ensureChatFolder(env, chan.folder_id, chatId);
    return chatId + '（目录 #' + fid + '）';
  };

  // 1) getFile → 临时下载路径
  let info: any;
  try {
    info = await tgApi(cfg.botToken, 'getFile', { file_id: picked.fileId }, cfg.apiBase);
  } catch (e: any) {
    const m = String(e?.message || e);
    await reply(`❌ 存入失败（拉取文件）：${m}\n（云 API 对超过 20MB 的文件会直接拒掉，大文件请确保走本地 Bot API）`);
    return { ok: true, skipped: 'getFile failed', error: m };
  }
  const filePath = info.file_path as string;
  if (!filePath) {
    await reply('❌ 存入失败：getFile 没返回 file_path');
    return { ok: true, skipped: 'no file_path' };
  }

  // 2) 下载 + 3) 落盘 —— 全程 try/catch，任何异常都回执给用户
  let size = 0;
  try {
    // 本地 Bot API Server 的 getFile 返回绝对路径（如 /var/lib/telegram-bot-api/<tok>/xxx），
    // 云 API 返回相对路径（如 documents/file_1.pdf）。下载 URL 只接相对部分：
    //   云：  {base}/file/bot{token}/{file_path}
    //   本地：{base}/file/bot{token}/{相对路径}（把盘符/绝对前缀剥掉，只留 token 之后那段）
    let rel = String(filePath).replace(/\\/g, '/');
    // 统一成「相对 file 接口的路径」：
    //   云 API:      documents/file_1.pdf            （已是相对）
    //   本地 Bot API: 可能是绝对路径 /var/lib/telegram-bot-api/<token>/photos/file_2.jpg
    //               也可能是 <token>/photos/file_2.jpg —— 都要剥到 <token>/ 之后的相对段
    const marker = `/bot${cfg.botToken}/`;
    const mi = rel.indexOf(marker);
    if (mi >= 0) {
      rel = rel.slice(mi + marker.length);
    } else {
      // 剥掉「<数字id>:<hash>/」这一段 token 目录前缀（本地 API 的落盘结构）
      rel = rel.replace(/^.*?(\d+:[A-Za-z0-9_-]+\/)/, '').replace(/^\/+/, '');
      // 兜底：仍带绝对盘路径前缀时，只留最后两段 photos/xxx 或 documents/xxx
    }
    if (/^\d+:[A-Za-z0-9_-]+\//.test(rel)) rel = rel.replace(/^\d+:[A-Za-z0-9_-]+\//, '');

    // 下载地址两种走法：
    //   ① 配了 tg_file_base（本地 Bot API 10.5 没有 /file/ 路由，由 nginx 静态服务磁盘）
    //        {fileBase}/<token>/<rel>，带 X-Tgfile-Secret 头
    //   ② 没配：官方 /file/bot<token>/<rel>
    let dl: Response;
    let dlUrl: string;
    if (cfg.fileBase) {
      // rel 已剥成 photos/file_5.jpg 这种相对段；静态服务目录结构是 <token>/photos/file_5.jpg
      dlUrl = `${cfg.fileBase}/${cfg.botToken}/${rel}`;
      const headers: Record<string, string> = {};
      if (cfg.fileSecret) headers['X-Tgfile-Secret'] = cfg.fileSecret;
      dl = await fetch(dlUrl, { headers });
    } else {
      dlUrl = `${cfg.apiBase.replace(/\/+$/, '')}/file/bot${cfg.botToken}/${rel}`;
      dl = await fetch(dlUrl);
    }
    if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}（路径 ${rel} · URL ${dlUrl}）`);
    // 大文件不能整块读进内存（Worker 内存 ~128MB，文件可到 2GB）：
    // 用 Content-Length 拿总大小，再按 Range 分块逐片拉取 + 逐片上传，全程只驻留一片。
    const contentLen = Number(dl.headers.get('content-length') || 0);
    let size0 = contentLen;
    if (!size0) {
      // 没有 Content-Length 兜底：整块读（小文件才走这里）
      const b0 = await dl.arrayBuffer();
      size0 = b0.byteLength;
    } else {
      // 释放首个响应体（这里只用来探大小），后面按 Range 重新取
      try { await dl.body?.cancel(); } catch { /* ignore */ }
    }
    size = size0;

    const TG_CHUNK = 25 * 1024 * 1024;
    const chunkSize = Math.min(Math.max(Math.min(size, TG_CHUNK), MIN_CHUNK), TG_CHUNK);
    const targetFolder = await ensureChatFolder(env, chan.folder_id, chatId);

    // ★ 续传：同一 chat + 同文件名 + 同大小 + 同 chunkSize 且还在 uploading 的会话，
    //   直接复用上次的 uploadId，已落库的片 putChunk 会自动 skipped，不重传。
    let resumeId = '';
    const prev = await env.DB.prepare(
      `SELECT id FROM uploads WHERE name = ? AND size = ? AND chunk_size = ? AND status = 'uploading'
         AND id IN (SELECT upload_id FROM tg_jobs WHERE chat_id = ? AND name = ? ORDER BY created_at DESC LIMIT 3)
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(picked.name, size, chunkSize, chatId, picked.name)
      .first<any>()
      .catch(() => null);
    if (prev?.id) resumeId = String(prev.id);

    let up: { uploadId: string; chunkSize: number; chunksCount: number };
    let resumed = false;
    if (resumeId) {
      const cnt = await env.DB.prepare('SELECT COUNT(*) c FROM chunks WHERE file_id = ?').bind(resumeId).first<any>().catch(() => null);
      up = { uploadId: resumeId, chunkSize, chunksCount: Math.max(1, Math.ceil(size / chunkSize)) };
      resumed = true;
      const have = Number(cnt?.c || 0);
      if (jobId) await updateJob(env, jobId, { phase: 'downloading', size, upload_id: resumeId, chunks_done: have }).catch(() => {});
      await reply(`♻️ 检测到未完成的上传（已 ${have} 片），从断点续传…`).catch(() => {});
    } else {
      up = await initUpload(env, { name: picked.name, folderId: targetFolder, size, chunkSize });
    }
    // ★ 续传批次要带 messageId，供完成后清理 TG 本地缓存
    const total = Math.max(1, Math.ceil(size / chunkSize));
    if (jobId)
      await updateJob(env, jobId, {
        phase: 'downloading', size, chunks_total: total, upload_id: up.uploadId,
        dl_url: dlUrl, file_base: cfg.fileBase || '', file_secret: cfg.fileSecret || '',
      }).catch(() => {});

    // ★ 免费计划单次 invocation 只有 50 个 subrequest，一大文件几十片必然打爆
    //   （实测 1.68GB 在 22 片时 Too many subrequests）。
    //   所以拆分：按 CHUNKS_PER_MSG 片一组，每组一条独立的 Queue 消息处理，
    //   每组 subrequest 预算重新算。全部片传完后由最后一条消息 completeUpload + 回执。
    const CHUNKS_PER_MSG = 3; // 3片≈3次下载+3次S3+~18次D1，控制在50以内
    const dlBase = dlUrl;
    if (env.TG_QUEUE) {
      // 入队所有批次；每条消息自带所需上下文（不依赖闭包，跨 invocation）
      const common = {
        kind: 'chunk-batch' as const,
        jobId,
        uploadId: up.uploadId,
        name: picked.name,
        size,
        chunkSize,
        total,
        dlUrl: dlBase,
        fileBase: cfg.fileBase,
        fileSecret: cfg.fileSecret,
        chatId,
        chanId: chan.id,
        folderId: chan.folder_id,
        hasFileContentLen: contentLen > 0,
        filePath: filePath || '',
      };
      // ★ 续传：找出已落库的片，只为缺失的片生成批次（已传的跳过，不重复入队）
      const haveRows = await env.DB.prepare('SELECT idx FROM chunks WHERE file_id = ?').bind(up.uploadId).all<any>().catch(() => null);
      const haveSet = new Set<number>(((haveRows?.results || []) as any[]).map((r) => Number(r.idx)));
      const missing: number[] = [];
      for (let i = 0; i < total; i++) if (!haveSet.has(i)) missing.push(i);
      // 按连续段切成 ≤CHUNKS_PER_MSG 的批次
      const ranges: { from: number; to: number }[] = [];
      let cur: number[] = [];
      for (const i of missing) {
        if (cur.length && i !== cur[cur.length - 1] + 1) { ranges.push({ from: cur[0], to: cur[cur.length - 1] }); cur = []; }
        cur.push(i);
        if (cur.length >= CHUNKS_PER_MSG) { ranges.push({ from: cur[0], to: cur[cur.length - 1] }); cur = []; }
      }
      if (cur.length) ranges.push({ from: cur[0], to: cur[cur.length - 1] });
      const batchRanges = ranges.length ? ranges : [{ from: 0, to: Math.min(total, CHUNKS_PER_MSG) - 1 }];
      if (missing.length === 0 && total > 0) {
        // 所有片都已落库 → 直接完成
        const done = await completeUpload(env, up.uploadId);
        if (jobId) await updateJob(env, jobId, { phase: 'done', chunks_done: total, bytes_done: size, file_id: done.fileId }).catch(() => {});
        await reply(`✅ 已存入网盘：${picked.name}（${fmtBytes(size)}）\n目录：${chatId}（目录 #${chan.folder_id ?? 'root'}）`).catch(() => {});
        return { ok: true, fileId: done.fileId, name: picked.name, size };
      }
      for (let b = 0; b < batchRanges.length; b++) {
        const r = batchRanges[b];
        await env.TG_QUEUE.send({ ...common, from: r.from, to: r.to, isLast: b === batchRanges.length - 1 });
      }
      // 已入队，回执已由「📥 收到」给过，最终结果由最后一批消息回
      return { ok: true, queued: true, batches: batchRanges.length, total, missing: missing.length };
    }

    // 无队列时退化：同步跑（小文件够用）
    const baseHeaders: Record<string, string> = {};
    if (cfg.fileBase && cfg.fileSecret) baseHeaders['X-Tgfile-Secret'] = cfg.fileSecret;
    const CONCURRENCY = Math.min(3, total);
    let nextIdx = 0;
    let doneChunks = 0;
    let doneBytes = 0;
    const worker = async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= total) break;
        const s = i * chunkSize;
        const e = Math.min(size, s + chunkSize) - 1;
        let part: ArrayBuffer;
        if (size <= MIN_CHUNK && contentLen === 0) {
          const r = await fetch(dlUrl, { headers: baseHeaders });
          part = await r.arrayBuffer();
        } else {
          const r = await fetch(dlUrl, { headers: { ...baseHeaders, Range: `bytes=${s}-${e}` } });
          if (!r.ok && r.status !== 206) throw new Error(`分块下载失败 HTTP ${r.status}（${s}-${e}）`);
          part = await r.arrayBuffer();
        }
        await putChunk(env, up.uploadId, i, part);
        doneChunks++;
        doneBytes = Math.min(size, doneBytes + part.byteLength);
        if (jobId)
          await updateJob(env, jobId, { phase: 'uploading', chunks_done: doneChunks, bytes_done: doneBytes }).catch(() => {});
      }
    };
    const runners: Promise<void>[] = [];
    for (let k = 0; k < CONCURRENCY; k++) runners.push(worker());
    await Promise.all(runners);
    const done = await completeUpload(env, up.uploadId);
    if (jobId) await updateJob(env, jobId, { phase: 'done', chunks_done: total, bytes_done: size, file_id: done.fileId }).catch(() => {});

    await setSetting(env, 'tg_last_at', new Date().toISOString());
    await env.DB.prepare('UPDATE tg_channels SET last_at = ? WHERE id = ?').bind(new Date().toISOString(), chan.id).run();
    const dir = await folderLabel();
    await reply(`✅ 已存入网盘：${picked.name}（${fmtBytes(size)}）\n目录：${dir}`);
    return { ok: true, fileId: done.fileId, name: picked.name, size };
  } catch (e: any) {
    const m = String(e?.message || e);
    console.log('tg store failed: ' + m);
    if (jobId) await updateJob(env, jobId, { phase: 'failed', error: m }).catch(() => {});
    await reply(`❌ 存入失败：${m}\n文件：${picked.name}（${fmtBytes(size || picked.size || 0)}）`);
    return { ok: true, skipped: 'store failed', error: m };
  }
}

/* ------------------------- TG 通道（每个通道 = 一个目录 + 一份白名单） ------------------------- */

export interface TgChunkBatchMsg {
  kind: 'chunk-batch';
  jobId: string;
  uploadId: string;
  name: string;
  size: number;
  chunkSize: number;
  total: number;
  dlUrl: string;
  fileBase: string;
  fileSecret: string;
  chatId: string;
  chanId: string;
  folderId: number | null;
  hasFileContentLen: boolean;
  from: number;
  to: number;
  isLast: boolean;
  filePath?: string;
}
/**
 * 清理标记表：某文件入库成功后，把服务器本地缓存路径记下来，
 * 由服务器上的定时脚本（cron）来删这些文件。**只删缓存，不删 TG 消息，也不动网盘分片数据。**
 */
export async function markCacheForSweep(env: Env, filePath: string | undefined | null, name: string): Promise<void> {
  if (!filePath || !filePath.trim()) return;
  try {
    await env.DB.prepare(
      `INSERT INTO tg_cache_sweep (id, path, name, created_at) VALUES (?,?,?,?)`,
    ).bind('cs_' + Math.random().toString(36).slice(2) + Date.now().toString(36), filePath.trim(), name || '', new Date().toISOString()).run();
  } catch { /* 表不存在就静默（首次需建表，见 schema.sql） */ }
}

/**
 * 对账收尾：当一个 job 还停在 uploading/downloading，但它的 upload 会话已经消失
 * （被某个并发批次 complete 掉了），说明文件其实已经入库 —— 但我们这一路没抢到末批的回写，
 * 于是 job 永远挂在 uploading。这里按 upload_id 去 files 表找对应成品，找到就把 job 标 done。
 * 找不到对应成品则什么都不做（交给正常流程/watchdog）。
 * 返回 true 表示已对账收尾。
 */
async function reconcileJobDone(env: Env, jobId: string, uploadId: string): Promise<boolean> {
  if (!jobId) return false;
  // upload 会话还在 → 说明没完成，别乱标
  const sess = await env.DB.prepare('SELECT id FROM uploads WHERE id = ?').bind(uploadId).first<any>();
  if (sess) return false;
  const job = await env.DB.prepare('SELECT * FROM tg_jobs WHERE id = ?').bind(jobId).first<any>();
  if (!job || job.phase === 'done') return false;
  // 找对应成品：优先 chunks 表里已改指到的 file_id；否则按 名称+大小+目录 最新 ready 文件兜底
  let fileId = '';
  const byChunk = await env.DB.prepare(
    'SELECT file_id FROM chunks WHERE file_id IN (SELECT id FROM files WHERE name = ? AND size = ? AND status = ?) LIMIT 1',
  ).bind(job.name, job.size, 'ready').first<any>().catch(() => null);
  if (byChunk?.file_id) fileId = String(byChunk.file_id);
  if (!fileId) {
    const f = await env.DB.prepare(
      "SELECT id FROM files WHERE name = ? AND size = ? AND status = 'ready' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ).bind(job.name, job.size).first<any>().catch(() => null);
    if (f?.id) fileId = String(f.id);
  }
  if (!fileId) return false;
  await updateJob(env, jobId, { phase: 'done', chunks_done: job.chunks_total || 0, bytes_done: job.size || 0, file_id: fileId, error: null }).catch(() => {});
  return true;
}

/**
 * 处理一批分片（跨多次 Queue 消息，绕开免费计划单次 50 subrequest 上限）。
 * 每批下载 [from,to] 片并 putChunk；更新进度；isLast 时 completeUpload + 回执。
 */
export async function processChunkBatch(env: Env, m: TgChunkBatchMsg): Promise<void> {
  const cfg = await getTgConfig(env);
  const baseHeaders: Record<string, string> = {};
  if (m.fileBase && m.fileSecret) baseHeaders['X-Tgfile-Secret'] = m.fileSecret;

  // 会话已被别的批次完成/清掉 → 这一批是重复投递。先对账：如果文件其实已入库，把 job 补齐成 done，
  // 否则直接跳过（避免退出码噪音）。
  const sess = await env.DB.prepare('SELECT id FROM uploads WHERE id = ?').bind(m.uploadId).first<any>();
  if (!sess) { await reconcileJobDone(env, m.jobId || '', m.uploadId).catch(() => {}); return; }

  // 幂等跳过：会话还在但所有片都已落库、且本 job 没在收尾 → 直接补一次完成，
  // 不再重新下载（否则批量时先到的批次把所有片传完，末批因「重复投递丢失」而永远不 complete，
  // job 就卡在 uploading 55/55）。
  if (m.jobId && !m.isLast && m.total) {
    const allCnt = await env.DB.prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) b FROM chunks WHERE file_id = ?').bind(m.uploadId).first<any>().catch(() => null);
    const haveN = Number(allCnt?.c || 0);
    const haveBytes = Number(allCnt?.b || 0);
    const jobNow = await env.DB.prepare('SELECT phase, size FROM tg_jobs WHERE id = ?').bind(m.jobId).first<any>().catch(() => null);
    if (haveN >= m.total && haveBytes >= (jobNow?.size || m.size) && jobNow && jobNow.phase !== 'done' && jobNow.phase !== 'completing') {
      const claimA = await env.DB.prepare(
        `UPDATE tg_jobs SET phase='completing', updated_at=? WHERE id=? AND phase IN ('downloading','uploading')`,
      ).bind(new Date().toISOString(), m.jobId).run().catch(() => null);
      if (claimA && claimA.meta.changes) {
        let fin: { fileId: string } | null = null;
        try { fin = await completeUpload(env, m.uploadId); } catch (e: any) { /* 可能被并发完成 */ }
        if (fin) {
          await updateJob(env, m.jobId, { phase: 'done', chunks_done: m.total, bytes_done: m.size, file_id: fin.fileId }).catch(() => {});
          await env.DB.prepare(`UPDATE tg_jobs SET phase='done', chunks_done=?, bytes_done=?, file_id=?, updated_at=? WHERE upload_id=? AND id<>? AND phase<>'done'`)
            .bind(m.total, m.size, fin.fileId, new Date().toISOString(), m.uploadId, m.jobId).run().catch(() => {});
          await setSetting(env, 'tg_last_at', new Date().toISOString());
          await tgApi(cfg.botToken, 'sendMessage', {
            chat_id: m.chatId,
            text: `✅ 已存入网盘：${m.name}（${fmtBytes(m.size)}）\n目录：${m.chatId}（目录 #${m.folderId == null ? 'root' : m.folderId}）`,
          }, cfg.apiBase).catch(() => {});
          await cleanupTgCache(env, (m as any).filePath).catch(() => {});
          await markCacheForSweep(env, (m as any).filePath, m.name).catch(() => {});
        } else {
          await reconcileJobDone(env, m.jobId, m.uploadId).catch(() => {});
        }
        return;
      }
      // 已被别的批次抢去收尾
      await reconcileJobDone(env, m.jobId, m.uploadId).catch(() => {});
      return;
    }
  }

  // 已落库的片跳过，只下缺失的（批量并发时前面批次可能已把片传完，避免重复下载与子请求浪费）
  const haveRows = await env.DB.prepare('SELECT idx FROM chunks WHERE file_id = ?').bind(m.uploadId).all<any>().catch(() => null);
  const haveSet = new Set<number>(((haveRows?.results || []) as any[]).map((r) => Number(r.idx)));

  for (let i = m.from; i <= m.to; i++) {
    if (haveSet.has(i)) continue;
    const s = i * m.chunkSize;
    const e = Math.min(m.size, s + m.chunkSize) - 1;
    const r = await fetch(m.dlUrl, { headers: { ...baseHeaders, Range: `bytes=${s}-${e}` } });
    if (!r.ok && r.status !== 206) throw new Error(`分块下载失败 HTTP ${r.status}（${s}-${e}）`);
    const part = await r.arrayBuffer();
    await putChunk(env, m.uploadId, i, part);
  }

  // 上传速率：用最近一段字节增量 / 时间差算瞬时速率，写进 job 让面板实时展示。
  // 以 job 上已记的 bytes_done + updated_at 作为上一采样点。
  let rateBps = 0;
  if (m.jobId) {
    const jr = await env.DB.prepare('SELECT bytes_done, rate_bps, updated_at FROM tg_jobs WHERE id = ?').bind(m.jobId).first<any>().catch(() => null);
    const prevBytes = Number(jr?.bytes_done || 0);
    const prevAt = jr?.updated_at ? Date.parse(jr.updated_at) : 0;
    const nowMs = Date.now();
    const cnt0 = await env.DB.prepare('SELECT COALESCE(SUM(size),0) b FROM chunks WHERE file_id = ?').bind(m.uploadId).first<any>().catch(() => null);
    const curBytes = Number(cnt0?.b || 0);
    const dt = prevAt ? (nowMs - prevAt) / 1000 : 0;
    const dB = curBytes - prevBytes;
    if (dt > 0.2 && dB > 0) rateBps = Math.round(dB / dt);
    else rateBps = Number(jr?.rate_bps || 0); // 太小的时间窗或不增，沿用上次速率
  }

  // 进度按已落库的 chunks 数算（更准，且并发安全）
  if (m.jobId) {
    const cnt = await env.DB.prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) b FROM chunks WHERE file_id = ?')
      .bind(m.uploadId)
      .first<any>();
    const doneCnt = Number(cnt?.c || 0);
    // 会话已被完成清掉时，chunks 表已改指到成品 file_id，COUNT 会变 0 —— 别把进度打回 0，
    // 也别把已 done 的 job 覆盖回 uploading。
    const stillSess = await env.DB.prepare('SELECT id FROM uploads WHERE id = ?').bind(m.uploadId).first<any>().catch(() => null);
    if (stillSess) {
      await updateJob(env, m.jobId, {
        phase: 'uploading',
        chunks_done: doneCnt,
        bytes_done: Math.min(m.size, Number(cnt?.b || 0)),
        chunks_total: m.total,
        rate_bps: rateBps,
      } as any).catch(() => {});
    }
  }

  if (!m.isLast) return;

  // 最后一批：先核对所有片是否齐全，缺片则重新入队补传（不 complete，避免坏文件）
  const cntAll = await env.DB.prepare('SELECT COUNT(*) c FROM chunks WHERE file_id = ?').bind(m.uploadId).first<any>();
  const have = Number(cntAll?.c || 0);
  if (have < m.total) {
    // 找回缺的片，重新入队（幂等，已传的会 skipped）
    if (m.jobId) await updateJob(env, m.jobId, { phase: 'uploading', chunks_done: have, chunks_total: m.total }).catch(() => {});
    if (env.TG_QUEUE) {
      const rows = await env.DB.prepare('SELECT idx FROM chunks WHERE file_id = ?').bind(m.uploadId).all<any>().catch(() => null);
      const haveSet = new Set<number>(((rows?.results || []) as any[]).map((r) => Number(r.idx)));
      const missing: number[] = [];
      for (let i = 0; i < m.total; i++) if (!haveSet.has(i)) missing.push(i);
      const ranges: { from: number; to: number }[] = [];
      let cur: number[] = [];
      for (const i of missing) {
        if (cur.length && i !== cur[cur.length - 1] + 1) { ranges.push({ from: cur[0], to: cur[cur.length - 1] }); cur = []; }
        cur.push(i);
        if (cur.length >= 3) { ranges.push({ from: cur[0], to: cur[cur.length - 1] }); cur = []; }
      }
      if (cur.length) ranges.push({ from: cur[0], to: cur[cur.length - 1] });
      const base = { ...m };
      for (let b = 0; b < ranges.length; b++) {
        await env.TG_QUEUE.send({ ...base, from: ranges[b].from, to: ranges[b].to, isLast: b === ranges.length - 1 });
      }
      return;
    }
    throw new Error(`分片不齐：${have}/${m.total}`);
  }

  // 片齐了：完成合并 + 回执（用作业对象锁，防多批次并发重复 complete）
  let done: { fileId: string } | null = null;
  if (m.jobId) {
    const claim = await env.DB.prepare(
      `UPDATE tg_jobs SET phase='completing', updated_at=? WHERE id=? AND phase IN ('downloading','uploading')`,
    ).bind(new Date().toISOString(), m.jobId).run();
    if (!claim.meta.changes) {
      // 已被别的批次抢先完成/正在完成。若它已把 upload 完成掉，对账把本 job 补齐成 done。
      await reconcileJobDone(env, m.jobId, m.uploadId).catch(() => {});
      return;
    }
  }
  try {
    done = await completeUpload(env, m.uploadId);
  } catch (e: any) {
    // 会话已被并发批次完成 → 对账补 done（而不是无脑标 done 丢 file_id）
    const fixed = m.jobId ? await reconcileJobDone(env, m.jobId, m.uploadId).catch(() => false) : false;
    if (m.jobId && !fixed) await updateJob(env, m.jobId, { phase: 'done' }).catch(() => {});
    return;
  }
  if (m.jobId) await updateJob(env, m.jobId, { phase: 'done', chunks_done: m.total, bytes_done: m.size, file_id: done.fileId }).catch(() => {});
  // 把同一 upload_id 的其它重复 job 一并收尾，避免面板留多条僵尸
  await env.DB.prepare(`UPDATE tg_jobs SET phase='done', chunks_done=?, bytes_done=?, file_id=?, updated_at=? WHERE upload_id=? AND id<>? AND phase<>'done'`)
    .bind(m.total, m.size, done.fileId, new Date().toISOString(), m.uploadId, m.jobId || '')
    .run().catch(() => {});
  await setSetting(env, 'tg_last_at', new Date().toISOString());
  await env.DB.prepare('UPDATE tg_channels SET last_at = ? WHERE id = ?').bind(new Date().toISOString(), m.chanId).run().catch(() => {});
  const dir = m.chatId + '（目录 #' + (m.folderId == null ? 'root' : m.folderId) + '）';
  await tgApi(cfg.botToken, 'sendMessage', {
    chat_id: m.chatId,
    text: `✅ 已存入网盘：${m.name}（${fmtBytes(m.size)}）\n目录：${dir}`,
  }, cfg.apiBase).catch(() => {});
  // 传完清服务器本地缓存（保留分片去重数据，不删 TG 消息）
  await cleanupTgCache(env, (m as any).filePath).catch(() => {});
  await markCacheForSweep(env, (m as any).filePath, m.name).catch(() => {});
}

/**
 * 传完后清理服务器上的 TG 本地缓存（Bot API 下载到磁盘的原文件），
 * 但**保留网盘里的分片数据**（chunks 表 + R2 对象），所以同一个视频再传会被去重、不会重复存。
 * 绝不删除 TG 里的历史消息。清理是「尽力而为」：失败不影响入库结果。
 */
export async function cleanupTgCache(env: Env, filePath: string | undefined | null): Promise<void> {
  if (!filePath || !filePath.trim()) return;
  const base = (await getTgConfig(env)).fileBase || '';
  if (!base) return; // 没配本地静态基址，说明走的是云 API，无服务器本地缓存可清
  // fileBase 形如 https://dsh.dante.us.ci/tgfile → 清理端点同源 /tgclean
  let root = '';
  try { root = new URL(base).origin; } catch { return; }
  const secret = (await getTgConfig(env)).fileSecret || '';
  const url = `${root}/tgclean?p=${encodeURIComponent(filePath)}`;
  try {
    await fetch(url, { method: 'POST', headers: { 'X-Tgfile-Secret': secret } });
  } catch { /* ignore */ }
}

/**
 * 重跑某个 job 的缺失分片（管理接口用）。从 job 里存的 dl_url/file_base 无状态重建批次，
 * 缺片自动补传，全齐则直接完成。返回补发批次数。
 */
export async function resumeJob(env: Env, jobId: string): Promise<{ ok: boolean; missing: number; batches: number; done?: boolean; error?: string }> {
  const job = await env.DB.prepare('SELECT * FROM tg_jobs WHERE id = ?').bind(jobId).first<any>();
  if (!job) return { ok: false, missing: 0, batches: 0, error: 'job 不存在' };
  if (job.phase === 'done') return { ok: true, missing: 0, batches: 0, done: true };
  const uploadId = job.upload_id;
  const dlUrl = job.dl_url;
  // 卡在 queued 且从未建成上传会话（入队即失败、或旧数据残缺）：无法续传，直接标记失败让面板说实话，
  // 用户重发该文件时 handleTgUpdate 会走全新一轮。
  if (!uploadId && (job.phase === 'queued' || job.phase === 'downloading')) {
    await updateJob(env, jobId, { phase: 'failed', error: '未能建立上传会话（未收到可下载的文件），请重新发送该文件' }).catch(() => {});
    return { ok: false, missing: 0, batches: 0, error: '未建立上传会话，已标记失败' };
  }
  if (!uploadId) return { ok: false, missing: 0, batches: 0, error: '该 job 未建立上传会话（还没下载阶段）' };
  if (!dlUrl) return { ok: false, missing: 0, batches: 0, error: '该 job 未记录下载地址（旧版本任务无法续传）' };

  const up = await env.DB.prepare('SELECT chunk_size, chunks_count, folder_id FROM uploads WHERE id = ?').bind(uploadId).first<any>();
  if (!up) return { ok: false, missing: 0, batches: 0, error: '上传会话不存在' };
  const chunkSize = Number(up.chunk_size);
  const total = Number(up.chunks_count);
  const size = Number(job.size);

  const rows = await env.DB.prepare('SELECT idx FROM chunks WHERE file_id = ?').bind(uploadId).all<any>();
  const have = new Set<number>(((rows.results || []) as any[]).map((r) => Number(r.idx)));
  const missing: number[] = [];
  for (let i = 0; i < total; i++) if (!have.has(i)) missing.push(i);

  if (missing.length === 0) {
    const done = await completeUpload(env, uploadId);
    await updateJob(env, jobId, { phase: 'done', chunks_done: total, bytes_done: size, file_id: done.fileId }).catch(() => {});
    return { ok: true, missing: 0, batches: 0, done: true };
  }

  // 连续段切成 ≤3 片的批次
  const ranges: { from: number; to: number }[] = [];
  let cur: number[] = [];
  for (const i of missing) {
    if (cur.length && i !== cur[cur.length - 1] + 1) { ranges.push({ from: cur[0], to: cur[cur.length - 1] }); cur = []; }
    cur.push(i);
    if (cur.length >= 3) { ranges.push({ from: cur[0], to: cur[cur.length - 1] }); cur = []; }
  }
  if (cur.length) ranges.push({ from: cur[0], to: cur[cur.length - 1] });

  const common: TgChunkBatchMsg = {
    kind: 'chunk-batch',
    jobId,
    uploadId,
    name: job.name,
    size,
    chunkSize,
    total,
    dlUrl,
    fileBase: job.file_base || '',
    fileSecret: job.file_secret || '',
    chatId: String(job.chat_id),
    chanId: '',
    folderId: up.folder_id == null ? null : Number(up.folder_id),
  } as TgChunkBatchMsg;
  if (!env.TG_QUEUE) return { ok: false, missing: missing.length, batches: 0, error: '无队列绑定' };
  for (let b = 0; b < ranges.length; b++) {
    await env.TG_QUEUE.send({ ...common, from: ranges[b].from, to: ranges[b].to, isLast: b === ranges.length - 1 });
  }
  await updateJob(env, jobId, { phase: 'uploading', chunks_done: have.size, chunks_total: total }).catch(() => {});
  return { ok: true, missing: missing.length, batches: ranges.length };
}

/**
 * 看门狗：延时到达后扫描某 chat 未完成的 job（phase in downloading/uploading 且 chunks 不齐），
 * 自动补发缺失片。实现「失败/停滞自愈」，用户不需要手动点续传。
 */
export async function watchdogResume(env: Env, chatId: string): Promise<void> {
  const jobs = await env.DB.prepare(
    `SELECT id, upload_id, phase, created_at, updated_at FROM tg_jobs WHERE chat_id = ? AND phase IN ('queued','downloading','uploading') ORDER BY created_at DESC LIMIT 8`,
  ).bind(chatId).all<any>();
  const now = Date.now();
  for (const j of (jobs.results || []) as any[]) {
    const id = String(j.id);
    // ① queued 却迟迟没建立上传会话：多半是 webhook 探大小/建会话那步就死了。
    //    绝不能让它永远显示「排队中」——超过 120 秒还是 queued 且无 upload_id，就直接判失败、说实话。
    if (j.phase === 'queued' && !j.upload_id) {
      const age = now - Date.parse(j.updated_at || j.created_at || '0');
      if (age > 120 * 1000) {
        await updateJob(env, id, { phase: 'failed', error: '未能建立下载会话（准备阶段超时），请重新发送该文件' }).catch(() => {});
        continue;
      }
      continue; // 120 秒内还在准备，先别动，等下一条 watchdog
    }
    // ② 已入库但没抢到 done 回写（upload 会话已消失）：对账补 done，避免无限空转。
    if (j.upload_id) {
      const fixed = await reconcileJobDone(env, id, String(j.upload_id)).catch(() => false);
      if (fixed) continue;
    }
    await resumeJob(env, id).catch(() => {});
  }
}

export interface TgChannel {
  id: string;
  name: string;
  folder_id: number | null;
  bot_username: string;
  allowed: string[];
  enabled: boolean;
  created_at: string;
  last_at: string | null;
}

function splitIds(s: any): string[] {
  return String(s || '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function mapChannel(r: any): TgChannel {
  return {
    id: r.id,
    name: r.name,
    folder_id: r.folder_id == null ? null : Number(r.folder_id),
    bot_username: r.bot_username || '',
    allowed: splitIds(r.allowed),
    enabled: !!r.enabled,
    created_at: r.created_at || '',
    last_at: r.last_at || null,
  };
}

export async function listChannels(env: Env): Promise<TgChannel[]> {
  const { results } = await env.DB.prepare('SELECT * FROM tg_channels ORDER BY created_at DESC').all<any>();
  return (results || []).map(mapChannel);
}

export async function getChannel(env: Env, id: string): Promise<TgChannel | null> {
  const r = await env.DB.prepare('SELECT * FROM tg_channels WHERE id = ?').bind(id).first<any>();
  return r ? mapChannel(r) : null;
}

export async function createChannel(
  env: Env,
  o: { name: string; folderId: number | null; botUsername?: string; allowedRaw?: string },
): Promise<TgChannel> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO tg_channels (id, name, folder_id, bot_username, allowed, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  )
    .bind(id, o.name, o.folderId, (o.botUsername || '').trim(), splitIds(o.allowedRaw).join(','), new Date().toISOString())
    .run();
  return (await getChannel(env, id))!;
}

export async function updateChannel(
  env: Env,
  id: string,
  o: { name?: string; folderId?: number | null; botUsername?: string; allowedRaw?: string; enabled?: boolean },
) {
  const sets: string[] = [];
  const vals: any[] = [];
  if (o.name !== undefined) { sets.push('name = ?'); vals.push(o.name); }
  if (o.folderId !== undefined) { sets.push('folder_id = ?'); vals.push(o.folderId); }
  if (o.botUsername !== undefined) { sets.push('bot_username = ?'); vals.push(o.botUsername.trim()); }
  if (o.allowedRaw !== undefined) { sets.push('allowed = ?'); vals.push(splitIds(o.allowedRaw).join(',')); }
  if (typeof o.enabled === 'boolean') { sets.push('enabled = ?'); vals.push(o.enabled ? 1 : 0); }
  if (!sets.length) return;
  vals.push(id);
  await env.DB.prepare(`UPDATE tg_channels SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function deleteChannel(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM tg_channels WHERE id = ?').bind(id).run();
}
