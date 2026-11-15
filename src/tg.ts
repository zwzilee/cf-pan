import type { Env } from './types';
import { getSetting, setSetting } from './util';
import { initUpload, putChunk, completeUpload, MIN_CHUNK, MAX_CHUNK } from './chunk';

/**
 * Telegram 上传渠道：给自己的 Telegram 机器人发文件 → 自动落进网盘。
 *
 * 玩法：
 *   1. @BotFather 建个 bot，拿 token；后台「TG 上传」页填进去。
 *   2. 后台点「注册 Webhook」，把 https://<worker>/api/tg/webhook/<secret> 设给 Telegram。
 *   3. 给 bot 发文件（document/video/audio/voice/photo），消息一到就落盘。
 *
 * 限制（Telegram 官方）：Bot API 单文件下载上限 20MB；请求体/超时也有限，
 * 所以这渠道适合文档、图片、小视频；大文件还是走面板分片上传。
 */

export const TG_MAX_BYTES = 20 * 1024 * 1024;

export interface TgConfig {
  botToken: string;
  secret: string;
  /** 允许的 chat id；空 = 不限制（任何能给 bot 发消息的人都能传） */
  allowed: string[];
  /** 落到哪个目录；null = 根目录 */
  folderId: number | null;
}

export async function getTgConfig(env: Env): Promise<TgConfig> {
  const [token, secret, allowed, folder] = await Promise.all([
    getSetting(env, 'tg_bot_token'),
    getSetting(env, 'tg_secret'),
    getSetting(env, 'tg_allowed'),
    getSetting(env, 'tg_folder'),
  ]);
  return {
    botToken: (token || '').trim(),
    secret: (secret || '').trim(),
    allowed: String(allowed || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    folderId: folder && /^\d+$/.test(String(folder)) ? Number(folder) : null,
  };
}

export async function saveTgConfig(env: Env, patch: Partial<TgConfig> & { allowedRaw?: string }): Promise<TgConfig> {
  if (patch.botToken !== undefined) await setSetting(env, 'tg_bot_token', patch.botToken.trim());
  if (patch.secret !== undefined) await setSetting(env, 'tg_secret', patch.secret.trim());
  if (patch.allowedRaw !== undefined) await setSetting(env, 'tg_allowed', patch.allowedRaw.trim());
  else if (patch.allowed !== undefined) await setSetting(env, 'tg_allowed', patch.allowed.join(','));
  if (patch.folderId !== undefined) await setSetting(env, 'tg_folder', patch.folderId == null ? '' : String(patch.folderId));
  return getTgConfig(env);
}

export function newTgSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 调 Telegram Bot API（GET，带 query） */
export async function tgApi(
  botToken: string,
  method: string,
  params: Record<string, string | number> = {},
): Promise<any> {
  const u = new URL(`https://api.telegram.org/bot${botToken}/${method}`);
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
  });
  await setSetting(env, 'tg_webhook_url', url);
  return { url, result: r };
}

export async function getTgWebhookInfo(env: Env): Promise<any> {
  const cfg = await getTgConfig(env);
  if (!cfg.botToken) return { configured: false };
  try {
    const info = await tgApi(cfg.botToken, 'getWebhookInfo');
    const me = await tgApi(cfg.botToken, 'getMe').catch(() => null);
    return { configured: true, url: info.url || '', pending: info.pending_update_count || 0, lastError: info.last_error_message || '', bot: me?.username ? '@' + me.username : '' };
  } catch (e: any) {
    return { configured: true, error: e?.message || String(e) };
  }
}

export async function deleteTgWebhook(env: Env): Promise<any> {
  const cfg = await getTgConfig(env);
  if (!cfg.botToken) throw new Error('还没填 bot token');
  await tgApi(cfg.botToken, 'deleteWebhook', { drop_pending_updates: 'true' });
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
export async function handleTgUpdate(env: Env, update: any): Promise<any> {
  const cfg = await getTgConfig(env);
  const msg = update?.message || update?.channel_post;
  if (!msg) return { ok: true, skipped: 'no message' };
  const chatId = String(msg.chat?.id ?? '');

  const reply = async (text: string) => {
    if (!cfg.botToken) return;
    try {
      await tgApi(cfg.botToken, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: 'true' });
    } catch {
      /* 回不了就算了 */
    }
  };

  if (cfg.allowed.length && !cfg.allowed.includes(chatId)) {
    return { ok: true, skipped: 'chat not allowed: ' + chatId };
  }

  const picked = pickFile(msg);
  if (!picked) {
    await reply('发文件给我就行：文档 / 视频 / 音频 / 图片，最大 20MB（Telegram Bot API 限制）。');
    return { ok: true, skipped: 'no file' };
  }
  if (picked.size && picked.size > TG_MAX_BYTES) {
    await reply(`「${picked.name}」${fmtBytes(picked.size)}，超过 Bot API 的 20MB 上限，传不了。大文件请用网页面板分片上传。`);
    return { ok: true, skipped: 'too big' };
  }

  // 1) getFile → 临时下载路径
  const info = await tgApi(cfg.botToken, 'getFile', { file_id: picked.fileId });
  const filePath = info.file_path as string;
  if (!filePath) throw new Error('getFile 没返回 file_path');

  // 2) 下载内容
  const dl = await fetch(`https://api.telegram.org/file/bot${cfg.botToken}/${filePath}`);
  if (!dl.ok) throw new Error(`下载失败 HTTP ${dl.status}`);
  const buf = await dl.arrayBuffer();
  const size = buf.byteLength;

  // 3) 落盘（单分片：20MB 以内一片搞定）
  const chunkSize = Math.min(Math.max(size, MIN_CHUNK), MAX_CHUNK);
  const up = await initUpload(env, { name: picked.name, folderId: cfg.folderId, size, chunkSize });
  await putChunk(env, up.uploadId, 0, buf);
  const done = await completeUpload(env, up.uploadId);

  await setSetting(env, 'tg_last_at', new Date().toISOString());
  await reply(`✅ 已存入网盘：${picked.name}（${fmtBytes(size)}）`);
  return { ok: true, fileId: done.fileId, name: picked.name, size };
}
