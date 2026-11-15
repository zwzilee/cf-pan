import type { Account, Env } from './types';
import { decryptSecret, encryptSecret } from './crypto';
import { nowISO } from './util';

/** 读账号池并把 secret 解密成明文供 s3 使用 */
export async function listAccounts(env: Env, enabledOnly = false): Promise<Account[]> {
  const q = enabledOnly ? 'SELECT * FROM accounts WHERE enabled = 1' : 'SELECT * FROM accounts';
  const { results } = await env.DB.prepare(q).all<any>();
  return Promise.all(
    results.map(async (r) => ({ ...r, secret_access_key: await decryptSecret(env.MASTER_KEY, r.secret_access_key) })),
  );
}

export async function getAccount(env: Env, id: number): Promise<Account | null> {
  const r = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<any>();
  if (!r) return null;
  return { ...r, secret_access_key: await decryptSecret(env.MASTER_KEY, r.secret_access_key) };
}

export async function createAccount(
  env: Env,
  a: {
    name: string;
    account_id: string;
    bucket: string;
    access_key_id: string;
    secret_access_key: string;
    capacity_bytes?: number;
    weight?: number;
  },
): Promise<number> {
  const secret = await encryptSecret(env.MASTER_KEY, a.secret_access_key);
  const res = await env.DB.prepare(
    `INSERT INTO accounts
       (name, account_id, bucket, access_key_id, secret_access_key, capacity_bytes, used_bytes, weight, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?)`,
  )
    .bind(
      a.name,
      a.account_id,
      a.bucket,
      a.access_key_id,
      secret,
      a.capacity_bytes ?? 10 * 1024 ** 3,
      a.weight ?? 1,
      nowISO(),
    )
    .run();
  return Number(res.meta.last_row_id);
}

/** 剩余空间最大的可用账号（自动把新分片摊到最空的桶上） */
export function pickAccount(accounts: Account[]): Account {
  const fit = accounts.filter((a) => a.enabled && a.capacity_bytes - a.used_bytes > 0);
  if (!fit.length) throw new Error('账号池没有可用空间，先加账号或清理文件');
  return fit.reduce((best, a) =>
    a.capacity_bytes - a.used_bytes > best.capacity_bytes - best.used_bytes ? a : best,
  );
}

/** 记账：先扣后传，失败再回滚（delta 可为负） */
export async function reserveBytes(env: Env, id: number, delta: number): Promise<void> {
  await env.DB.prepare('UPDATE accounts SET used_bytes = MAX(0, used_bytes + ?) WHERE id = ?').bind(delta, id).run();
}
