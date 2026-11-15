export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS?: Fetcher;
  JWT_SECRET: string;
  MASTER_KEY?: string;
  PUBLIC_APP_NAME?: string;
  BOOTSTRAP_ADMIN?: string;
}

/** 账号池里的一条记录（secret 已解密为明文） */
export interface Account {
  id: number;
  name: string;
  account_id: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  capacity_bytes: number;
  used_bytes: number;
  weight: number;
  enabled: number;
}

export interface ChunkRow {
  id: number;
  file_id: string;
  idx: number;
  account_id: number;
  bucket: string;
  object_key: string;
  size: number;
  etag: string | null;
}
