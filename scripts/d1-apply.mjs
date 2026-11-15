import { readFileSync } from 'node:fs';

const TOKEN = process.env.CF_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const ACC = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
const DB = process.env.D1_ID || process.env.D1_DATABASE_ID;

if (!TOKEN || !ACC || !DB) {
  console.error('需要 CF_TOKEN / CF_ACCOUNT_ID / D1_ID 三个环境变量');
  process.exit(1);
}

const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const url = `https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`;
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql }),
});

const body = await res.json();
if (!body.success) {
  console.error(JSON.stringify(body.errors, null, 2));
  process.exit(1);
}
const statements = body.result?.[0]?.meta?.changes ?? '?';
console.log('schema applied:', res.status, 'changes:', statements);
const tables = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" }),
});
const t = await tables.json();
console.log('tables:', (t.result?.[0]?.results || []).map((r) => r.name).join(', '));
