-- PAN R2 元数据库 (Cloudflare D1 / SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,                 -- pbkdf2$迭代$salt$hash
  role TEXT NOT NULL DEFAULT 'admin',      -- admin | user
  created_at TEXT NOT NULL
);

-- 账号池：每个 Cloudflare 账号一个 R2 桶（也可同账号多桶）
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL,                -- Cloudflare Account ID
  bucket TEXT NOT NULL,
  access_key_id TEXT NOT NULL,             -- R2 S3 Access Key ID
  secret_access_key TEXT NOT NULL,         -- 配了 MASTER_KEY 则为 AES-GCM 密文(enc:...)
  capacity_bytes INTEGER NOT NULL DEFAULT 10737418240,  -- 默认 10GB 免费额度
  used_bytes INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NULL REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 上传会话（未完成的上传）
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_id INTEGER NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunks_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_id INTEGER NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunks_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  sha256 TEXT NULL,
  created_at TEXT NOT NULL
);

-- 分片清单：file_id 上传中=uploads.id，完成后=files.id
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(file_id, idx)
);

-- 访问日志：每个 /api/* 请求一条，后台「访问」页看最近谁来过
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,                  -- CF-Connecting-IP
  country TEXT,                      -- request.cf.country
  city TEXT,                         -- request.cf.city
  ua TEXT,                           -- User-Agent（截断 300）
  method TEXT NOT NULL,
  path TEXT NOT NULL,                -- pathname + query（截断 300）
  status INTEGER NOT NULL,
  uid INTEGER,                       -- 已登录时记用户 id
  username TEXT,
  referer TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id, idx);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_accounts_enabled ON accounts(enabled);
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(id DESC);
CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip, id DESC);
