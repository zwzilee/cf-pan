-- PAN R2 元数据库 (Cloudflare D1 / SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,                 -- pbkdf2$迭代$salt$hash
  role TEXT NOT NULL DEFAULT 'admin',      -- admin=后台管理员 | user=前台访客
  front_enabled INTEGER NOT NULL DEFAULT 1, -- 前台账号是否允许访问
  created_at TEXT NOT NULL
);

-- 在线表格：结构化数据存 D1，不进 R2
CREATE TABLE IF NOT EXISTS sheets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 30,
  cols INTEGER NOT NULL DEFAULT 12,
  folder_id INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sheets_folder ON sheets(folder_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sheet_cells (
  sheet_id TEXT NOT NULL,
  r INTEGER NOT NULL,
  c INTEGER NOT NULL,
  v TEXT NOT NULL,
  PRIMARY KEY (sheet_id, r, c)
);

-- 在线文档：文本 / Markdown / 代码
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_id INTEGER NULL,
  content TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_folder ON docs(folder_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

-- 内容寻址：一个 sha256 只存一份，多个分片引用同一个对象（refs 计数）
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,              -- sha256(分片内容) 十六进制
  size INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  etag TEXT,
  refs INTEGER NOT NULL DEFAULT 1,    -- 有多少个分片在引用；归零才真删
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_account ON blobs(account_id);

-- 分片清单：file_id 上传中=uploads.id，完成后=files.id
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  hash TEXT,                          -- 指向 blobs.hash（去重用）
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

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'read',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS dav_mounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_id INTEGER NULL,
  username TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  readonly INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dav_mounts_hash ON dav_mounts(key_hash);
CREATE INDEX IF NOT EXISTS idx_dav_mounts_folder ON dav_mounts(folder_id);