import type { Env } from './types';
import { requireAny } from './roles';

/**
 * 在线编辑：文本 / 代码 / Markdown 的「记事本」。
 *
 * 数据存 D1，不进 R2：这类文件通常几十 KB、改动频繁，放 R2 每次保存都要
 * 重新分片写对象。文档本身也是资产，出现在前台目录里，访客能看（只读），
 * 管理员能改。
 *
 *   docs(id UUID, name, folder_id, content, size, created_at, updated_at)
 *
 * content 上限 1MB（D1 单值上限附近，留余量）。
 */

export const MAX_DOC = 1024 * 1024;

export interface DocRow {
  id: string;
  name: string;
  folder_id: number | null;
  size: number;
  updated_at: string;
  created_at: string;
}

export async function listDocs(env: Env, folderId: number | null): Promise<DocRow[]> {
  const sql =
    folderId === null
      ? 'SELECT id,name,folder_id,size,updated_at,created_at FROM docs WHERE folder_id IS NULL ORDER BY updated_at DESC'
      : 'SELECT id,name,folder_id,size,updated_at,created_at FROM docs WHERE folder_id = ? ORDER BY updated_at DESC';
  const stmt = folderId === null ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(folderId);
  const { results } = await stmt.all<DocRow>();
  return results;
}

export async function getDoc(env: Env, id: string) {
  return await env.DB.prepare('SELECT * FROM docs WHERE id = ?').bind(id).first<any>();
}

export async function createDoc(env: Env, args: { name: string; folderId?: number | null; content?: string }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const content = String(args.content ?? '');
  await env.DB.prepare(
    'INSERT INTO docs (id,name,folder_id,content,size,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(id, args.name || '未命名文档', args.folderId ?? null, content, byteLen(content), now, now)
    .run();
  return { id };
}

export async function saveDoc(env: Env, id: string, content: string) {
  const size = byteLen(content);
  if (size > MAX_DOC) throw new Error(`文档太大（上限 ${MAX_DOC} 字节）`);
  await env.DB.prepare('UPDATE docs SET content = ?, size = ?, updated_at = ? WHERE id = ?')
    .bind(content, size, new Date().toISOString(), id)
    .run();
  return { ok: true, size };
}

export async function renameDoc(env: Env, id: string, name: string) {
  await env.DB.prepare('UPDATE docs SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, new Date().toISOString(), id)
    .run();
}

export async function deleteDoc(env: Env, id: string) {
  await env.DB.prepare('DELETE FROM docs WHERE id = ?').bind(id).run();
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** 前台「读」的入口：把文档渲染成一个静态页面 */
export function renderDocPage(name: string, content: string, updatedAt: string): string {
  const isMd = /\.(md|markdown)$/i.test(name);
  const body = isMd ? mdToHtml(content) : `<pre class="raw">${escHtml(content)}</pre>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(name)} · PAN R2</title>
<style>
:root{--bg:#0b0e14;--fg:#e8eefc;--mut:#8b97ad;--line:#232b3a;--accent:#4f8cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.8 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:40px 24px 80px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:26px}
h1{font-size:18px;margin:0;word-break:break-all}
.meta{color:var(--mut);font-size:12px}
pre.raw{white-space:pre-wrap;word-break:break-word;background:#131823;border:1px solid var(--line);border-radius:10px;padding:16px;font:13px/1.7 ui-monospace,Consolas,monospace}
h2{font-size:17px;margin:28px 0 10px;border-left:3px solid var(--accent);padding-left:10px}
h3{font-size:15px;margin:20px 0 8px}
p{margin:10px 0}code{background:#1a2130;padding:1px 5px;border-radius:4px;font:12.5px ui-monospace,Consolas,monospace}
pre{background:#131823;border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto}
pre code{background:none;padding:0}
a{color:var(--accent)}blockquote{border-left:3px solid var(--line);margin:12px 0;padding:2px 14px;color:var(--mut)}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
</style></head><body><div class="wrap">
<header><h1>${escHtml(name)}</h1><span class="meta">更新于 ${new Date(updatedAt).toLocaleString('zh-CN')}</span></header>
${body}
</div></body></html>`;
}

/** 极简 Markdown → HTML：标题、列表、代码块、粗斜体、行内码、链接、引用、分隔线 */
export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let listOpen: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const inline = (s: string): string => {
    let t = escHtml(s);
    t = t.replace(/`([^`]+)`/g, (_m, a) => `<code>${a}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return t;
  };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      flushPara();
      closeList();
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        out.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escHtml(line));
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      closeList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      if (listOpen !== 'ul') {
        closeList();
        out.push('<ul>');
        listOpen = 'ul';
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (listOpen !== 'ol') {
        closeList();
        out.push('<ol>');
        listOpen = 'ol';
      }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push('<hr>');
      continue;
    }
    para.push(line);
  }
  if (inCode) out.push('</code></pre>');
  flushPara();
  closeList();
  return out.join('\n');
}

export { requireAny };
