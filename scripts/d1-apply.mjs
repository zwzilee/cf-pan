// 用 Node 打 D1 HTTP API：读 schema.sql（UTF-8）→ POST /query
// 用法：CF_TOKEN=xxx CF_ACCOUNT_ID=yyy D1_ID=zzz node scripts/d1-apply.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.CF_TOKEN;
const account = process.env.CF_ACCOUNT_ID;
const dbId = process.env.D1_ID;

if (!token || !account || !dbId) {
  console.error('需要 CF_TOKEN / CF_ACCOUNT_ID / D1_ID');
  process.exit(1);
}

const sql = readFileSync(resolve(root, 'schema.sql'), 'utf8');
const url = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${dbId}/query`;

const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql }),
});
const j = await res.json();

if (!j.success) {
  console.error('失败:', res.status, JSON.stringify(j.errors, null, 2));
  process.exit(1);
}
for (const r of j.result || []) {
  console.log(`ok=${r.success} changes=${r.meta?.changes ?? '-'} rows=${r.results?.length ?? 0}`);
}
console.log('schema 已应用');
