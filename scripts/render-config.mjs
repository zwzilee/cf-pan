#!/usr/bin/env node
// 把 wrangler.toml 里的占位符换成真实值，产出 .wrangler-deploy.toml 再部署。
// 用法（本地或 CI 都行）：
//   D1_DATABASE_ID=xxx KV_NAMESPACE_ID=yyy BOOTSTRAP_ADMIN=admin:密码 node scripts/render-config.mjs
//   npx wrangler deploy --config .wrangler-deploy.toml
//
// 为什么需要这一步：D1 / KV 的 id 是「部署期绑定」，不是运行时 env，
// 不能像普通变量那样在控制台里改。只有 BOOTSTRAP_ADMIN 这类 [vars] 能走环境变量。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'wrangler.toml');
const out = resolve(root, '.wrangler-deploy.toml');

let toml = readFileSync(src, 'utf8');

const d1 = process.env.D1_DATABASE_ID || '';
const kv = process.env.KV_NAMESPACE_ID || '';
const admin = process.env.BOOTSTRAP_ADMIN || '';
const appName = process.env.PUBLIC_APP_NAME || '';

if (!d1 || !kv) {
  console.error('缺少 D1_DATABASE_ID 或 KV_NAMESPACE_ID。');
  console.error('  先建：npx wrangler d1 create pan_r2 / npx wrangler kv namespace create PAN_R2_KV');
  console.error('  再把返回的 id 通过环境变量传进来。');
  process.exit(1);
}

toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${d1}"`);
toml = toml.replace(/^(\s*)id\s*=\s*"[^"]*"/m, `$1id = "${kv}"`);

if (admin) {
  toml = toml.replace(/BOOTSTRAP_ADMIN\s*=\s*"[^"]*"/, `BOOTSTRAP_ADMIN = "${admin}"`);
}
if (appName) {
  toml = toml.replace(/PUBLIC_APP_NAME\s*=\s*"[^"]*"/, `PUBLIC_APP_NAME = "${appName}"`);
}

// 二次检查：还有占位符就说明替换没生效，别把坏配置推上去
if (toml.includes('REPLACE_WITH_')) {
  console.error('替换后仍残留 REPLACE_WITH_，请检查 wrangler.toml 格式。');
  process.exit(1);
}

writeFileSync(out, toml, 'utf8');
console.log('已生成 .wrangler-deploy.toml');
console.log('  D1  =', d1);
console.log('  KV  =', kv);
console.log('  ADMIN =', admin ? '已设置（不打印）' : '沿用 wrangler.toml 默认值');
console.log('\n下一步：npx wrangler deploy --config .wrangler-deploy.toml');
