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
  const [token, secret, allowed, folder, base, max, admins] = await Promise.all([
    getSetting(env, 'tg_bot_token'),
    getSetting(env, 'tg_secret'),
    getSetting(env, 'tg_allowed'),
    getSetting(env, 'tg_folder'),
    getSetting(env, 'tg_api_base'),
    getSetting(env, 'tg_max_bytes'),
    getSetting(env, 'tg_admins'),
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

interface Picked {
  fileId: string;
  name: string;
  size: number;
  mime: string | null;
}

function pickFile(msg: any): Picked | null {
  if (msg.document) {
    const d = msg.document;
    return { fileId: d.file_id, name: d.file_name || `document_${msg.message_id}`, size: d.file_size || 0, mime: d.mime_type || null };
  }
  if (msg.video) {
    const v = msg.video;
    return { fileId: v.file_id, name: v.file_name || `video_${msg.message_id}.mp4`, size: v.file_size || 0, mime: v.mime_type || 'video/mp4' };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { fileId: a.file_id, name: a.file_name || `audio_${msg.message_id}.mp3`, size: a.file_size || 0, mime: a.mime_type || 'audio/mpeg' };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { fileId: v.file_id, name: `voice_${msg.message_id}.ogg`, size: v.file_size || 0, mime: v.mime_type || 'audio/ogg' };
  }
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { fileId: p.file_id, name: `photo_${msg.message_id}.jpg`, size: p.file_size || 0, mime: 'image/jpeg' };
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

  // 1) getFile → 临时下载路径
  let info: any;
  try {
    info = await tgApi(cfg.botToken, 'getFile', { file_id: picked.fileId }, cfg.apiBase);
  } catch (e: any) {
    const m = String(e?.message || e);
    await reply(`拉取失败：${m}\n（云 API 对超过 20MB 的文件会直接拒掉）`);
    return { ok: true, skipped: 'getFile failed', error: m };
  }
  const filePath = info.file_path as string;
  if (!filePath) throw new Error('getFile 没返回 file_path');

  // 2) 下载内容
  const dl = await fetch(`${cfg.apiBase.replace(/\/+$/, '')}/file/bot${cfg.botToken}/${filePath}`);
  if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}`);
  const buf = await dl.arrayBuffer();
  const size = buf.byteLength;

  // 3) 落盘（单片：单片上限 100MB，超过就按 100MB 切片）
  const chunkSize = Math.min(Math.max(Math.min(size, MAX_CHUNK), MIN_CHUNK), MAX_CHUNK);
  const targetFolder = await ensureChatFolder(env, chan.folder_id, chatId);
  const up = await initUpload(env, { name: picked.name, folderId: targetFolder, size, chunkSize });
  const total = Math.max(1, Math.ceil(size / chunkSize));
  for (let i = 0; i < total; i++) {
    const s = i * chunkSize;
    await putChunk(env, up.uploadId, i, buf.slice(s, Math.min(size, s + chunkSize)));
  }
  const done = await completeUpload(env, up.uploadId);

  await setSetting(env, 'tg_last_at', new Date().toISOString());
  await env.DB.prepare('UPDATE tg_channels SET last_at = ? WHERE id = ?').bind(new Date().toISOString(), chan.id).run();
  await reply(`✅ 已存入网盘：${picked.name}（${fmtBytes(size)}）`);
  return { ok: true, fileId: done.fileId, name: picked.name, size };
}

/* ------------------------- TG 通道（每个通道 = 一个目录 + 一份白名单） ------------------------- */

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
