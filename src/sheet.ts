import type { Env } from './types';

/**
 * 在线表格：像网盘里的「Excel」。
 *
 * 单元格只存 D1（一格一行，空格不写行），表格本身不进 R2 —— 它是结构化数据，
 * 塞进分片对象里既不能查也不好改。
 *
 *   sheets(id UUID, name, rows, cols, folder_id, created_at, updated_at)
 *   sheet_cells(sheet_id, r, c, v, UNIQUE(sheet_id,r,c))
 *
 * 保存用「整片覆盖」：DELETE 再批量 INSERT。比增量 diff 简单，几千格的表
 * 一次 batch 就完；D1 单语句参数上限 100，故每批 24 行格子（24×3=72）。
 */

export const MAX_ROWS = 5000;
export const MAX_COLS = 200;
const MAX_CELL = 2000; // 单格文本上限
const CELLS_PER_STMT = 24;

export interface SheetMeta {
  id: string;
  name: string;
  rows: number;
  cols: number;
  folder_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Cell {
  r: number;
  c: number;
  v: string;
}

export async function listSheets(env: Env, folderId: number | null): Promise<SheetMeta[]> {
  const sql =
    folderId === null
      ? 'SELECT id,name,rows,cols,folder_id,created_at,updated_at FROM sheets WHERE folder_id IS NULL ORDER BY updated_at DESC'
      : 'SELECT id,name,rows,cols,folder_id,created_at,updated_at FROM sheets WHERE folder_id = ? ORDER BY updated_at DESC';
  const stmt = folderId === null ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(folderId);
  const { results } = await stmt.all<SheetMeta>();
  return results;
}

export async function createSheet(
  env: Env,
  args: { name: string; rows?: number; cols?: number; folderId?: number | null },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = Math.min(Math.max(Number(args.rows) || 30, 1), MAX_ROWS);
  const cols = Math.min(Math.max(Number(args.cols) || 12, 1), MAX_COLS);
  await env.DB.prepare(
    'INSERT INTO sheets (id,name,rows,cols,folder_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(id, args.name || '未命名表格', rows, cols, args.folderId ?? null, now, now)
    .run();
  return { id, rows, cols };
}

export async function getSheet(env: Env, id: string) {
  const meta = await env.DB.prepare('SELECT * FROM sheets WHERE id = ?').bind(id).first<SheetMeta>();
  if (!meta) return null;
  const { results } = await env.DB.prepare('SELECT r,c,v FROM sheet_cells WHERE sheet_id = ? ORDER BY r,c')
    .bind(id)
    .all<Cell>();
  return { ...meta, cells: results };
}

/** 整体保存（整片覆盖）；返回写入的非空格子数 */
export async function saveSheet(
  env: Env,
  id: string,
  args: { rows?: number; cols?: number; cells: Cell[] },
): Promise<number> {
  const meta = await env.DB.prepare('SELECT rows,cols FROM sheets WHERE id = ?').bind(id).first<any>();
  if (!meta) throw new Error('表格不存在');

  const rows = Math.min(Math.max(Number(args.rows) || meta.rows, 1), MAX_ROWS);
  const cols = Math.min(Math.max(Number(args.cols) || meta.cols, 1), MAX_COLS);

  const clean = (args.cells || [])
    .filter((x) => x && Number.isFinite(x.r) && Number.isFinite(x.c) && x.v !== '' && x.v != null)
    .filter((x) => x.r >= 0 && x.r < rows && x.c >= 0 && x.c < cols)
    .map((x) => ({ r: Math.floor(x.r), c: Math.floor(x.c), v: String(x.v).slice(0, MAX_CELL) }));

  const stmts: D1PreparedStatement[] = [env.DB.prepare('DELETE FROM sheet_cells WHERE sheet_id = ?').bind(id)];
  for (let i = 0; i < clean.length; i += CELLS_PER_STMT) {
    const part = clean.slice(i, i + CELLS_PER_STMT);
    const values = part.map(() => '(?,?,?,?)').join(',');
    stmts.push(
      env.DB.prepare(`INSERT INTO sheet_cells (sheet_id,r,c,v) VALUES ${values}`).bind(
        ...part.flatMap((x) => [id, x.r, x.c, x.v]),
      ),
    );
  }
  stmts.push(
    env.DB.prepare('UPDATE sheets SET rows = ?, cols = ?, updated_at = ? WHERE id = ?').bind(
      rows,
      cols,
      new Date().toISOString(),
      id,
    ),
  );

  // D1 一次 batch 建议 ≤100 条语句
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return clean.length;
}

export async function renameSheet(env: Env, id: string, name: string) {
  await env.DB.prepare('UPDATE sheets SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, new Date().toISOString(), id)
    .run();
}

export async function deleteSheet(env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sheet_cells WHERE sheet_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sheets WHERE id = ?').bind(id),
  ]);
}

/** 导出 TSV：把 cells 还原成表格文本，UTF-8 BOM 由调用方加 */
export function exportSheet(sheet: { rows: number; cols: number; cells: Cell[] }): string {
  const cellMap = new Map<string, string>();
  for (const c of sheet.cells) cellMap.set(`${c.r},${c.c}`, c.v);
  const lines: string[] = [];
  for (let r = 0; r < sheet.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < sheet.cols; c++) {
      const raw = cellMap.get(`${r},${c}`) ?? '';
      // 公式导出成求值结果，Excel 打开就是数
      const v = raw.startsWith('=') ? evalFormula(raw, (rr, cc) => cellMap.get(`${rr},${cc}`) ?? '') : raw;
      row.push(/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    }
    lines.push(row.join('\t'));
  }
  return lines.join('\n');
}

/** 导入 TSV/CSV：自动识别逗号或制表符，支持双引号包裹 */
export function parseImport(text: string): { rows: number; cols: number; cells: Cell[] } {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const delim = clean.includes('\t') ? '\t' : ',';
  const grid: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      grid.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  row.push(field);
  grid.push(row);

  while (grid.length && grid[grid.length - 1].every((x) => x === '')) grid.pop();
  const rows = Math.min(Math.max(grid.length, 1), MAX_ROWS);
  const cols = Math.min(Math.max(Math.max(1, ...grid.map((r) => r.length)), 1), MAX_COLS);
  const cells: Cell[] = [];
  grid.slice(0, rows).forEach((r, ri) => {
    r.slice(0, cols).forEach((v, ci) => {
      if (v !== '') cells.push({ r: ri, c: ci, v: v.slice(0, MAX_CELL) });
    });
  });
  return { rows, cols, cells };
}

/** 兼容旧名 */
export const exportTsv = exportSheet;
export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const d = ch.charCodeAt(0) - 64;
    if (d < 1 || d > 26) return -1;
    n = n * 26 + d;
  }
  return n - 1;
}

/** 列号转表头字母：0→A, 25→Z, 26→AA */
export function indexToCol(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 极简公式求值：只支持 =SUM/AVG/MIN/MAX/COUNT(区间) 与 + - * / 与单元格引用。
 * 不 eval 任何用户字符串，靠手写词法+递归下降，避免在 Worker 里跑任意代码。
 */
export function evalFormula(
  raw: string,
  get: (r: number, c: number) => string,
  depth = 0,
): string {
  if (depth > 8) return '#循环';
  const src = raw.slice(1);
  let i = 0;

  const num = (v: string): number => {
    if (v === '' || v == null) return 0;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('#值');
    return n;
  };

  const readRange = (): number[] => {
    // 形如 A1:B3
    const start = i;
    while (i < src.length && /[A-Za-z0-9:$]/.test(src[i])) i++;
    const ref = src.slice(start, i);
    const m = /^\$?([A-Za-z]+)\$?(\d+):\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
    if (!m) throw new Error('#引用');
    const c1 = colToIndex(m[1]);
    const r1 = parseInt(m[2], 10) - 1;
    const c2 = colToIndex(m[3]);
    const r2 = parseInt(m[4], 10) - 1;
    const out: number[] = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        const v = get(r, c);
        if (v === '' || v == null) continue;
        if (v.startsWith('=')) {
          const inner = evalFormula(v, get, depth + 1);
          if (inner.startsWith('#')) continue;
          out.push(Number(inner));
        } else {
          const n = Number(v);
          if (Number.isFinite(n)) out.push(n);
        }
      }
    }
    return out;
  };

  const expr = (): number => {
    let v = term();
    while (i < src.length) {
      const ch = src[i];
      if (ch === '+') {
        i++;
        v += term();
      } else if (ch === '-') {
        i++;
        v -= term();
      } else break;
    }
    return v;
  };

  const term = (): number => {
    let v = factor();
    while (i < src.length) {
      const ch = src[i];
      if (ch === '*') {
        i++;
        v *= factor();
      } else if (ch === '/') {
        i++;
        const d = factor();
        if (d === 0) throw new Error('#除零');
        v /= d;
      } else break;
    }
    return v;
  };

  const factor = (): number => {
    while (src[i] === ' ') i++;
    if (src[i] === '(') {
      i++;
      const v = expr();
      if (src[i] !== ')') throw new Error('#括号');
      i++;
      return v;
    }
    if (src[i] === '-') {
      i++;
      return -factor();
    }
    const fn = /^(SUM|AVG|AVERAGE|MIN|MAX|COUNT)\(/i.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      const nums = readRange();
      if (src[i] !== ')') throw new Error('#函数');
      i++;
      switch (fn[1].toUpperCase()) {
        case 'SUM':
          return nums.reduce((a, b) => a + b, 0);
        case 'AVG':
        case 'AVERAGE':
          return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        case 'MIN':
          return nums.length ? Math.min(...nums) : 0;
        case 'MAX':
          return nums.length ? Math.max(...nums) : 0;
        case 'COUNT':
          return nums.length;
      }
    }
    // 单元格引用
    const cell = /^\$?([A-Za-z]+)\$?(\d+)/.exec(src.slice(i));
    if (cell) {
      i += cell[0].length;
      const r = parseInt(cell[2], 10) - 1;
      const c = colToIndex(cell[1]);
      const v = get(r, c);
      if (v && v.startsWith('=')) {
        const inner = evalFormula(v, get, depth + 1);
        return inner.startsWith('#') ? 0 : num(inner);
      }
      return num(v);
    }
    // 数字
    const nm = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (nm) {
      i += nm[0].length;
      return Number(nm[0]);
    }
    throw new Error('#语法');
  };

  try {
    const v = expr();
    if (i < src.length) return '#语法';
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  } catch (e: any) {
    return e?.message?.startsWith('#') ? e.message : '#错误';
  }
}

/** 单元格显示值：公式求值后的结果，普通值原样 */
export function displayValue(cells: Map<string, string>, r: number, c: number, stack = 0): string {
  const key = `${r},${c}`;
  const raw = cells.get(key) ?? '';
  if (!raw.startsWith('=')) return raw;
  if (stack > 8) return '#循环';
  return evalFormula(raw, (rr, cc) => cells.get(`${rr},${cc}`) ?? '', stack);
}
