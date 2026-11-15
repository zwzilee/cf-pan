# PAN R2 — 多 Cloudflare 账号 R2/S3 聚合网盘

把几十个 Cloudflare 账号的 R2 免费桶（每个 10GB）拼成一个统一网盘，Worker 部署、前后台双密码、大文件分片存、下载支持 Range 断点续传，自带在线表格与在线文档。

> 截图里 `70 账号 / 665GB / <1%` 就是这个思路：70 × ~9.5GB 实际可用 ≈ 665GB，一个前端看过去像一块大硬盘。

线上实例：<https://pan-r2.isophia1205.workers.dev>

---

## 一、为什么这么设计（关键决策）

| 问题 | 做法 | 原因 |
|---|---|---|
| 跨账号读写 R2 | **走 S3 兼容 API**（`aws4fetch` 签名），`https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>` | Worker 的 `R2Bucket` binding 只能访问**本账号**，池子里别的账号必须用 S3 Access Key |
| 大文件 | **自己切分片**，每片是一个独立对象，落在不同账号 | R2 的 multipart 要求所有 part 在同一对象/桶；要"摊到多个账号"只能应用层分片 |
| 分片怎么摊 | 每片选**剩余空间最大**的可用账号 | 自动均衡，别把某个桶写满 |
| 下载 | Worker 按 Range 定位到"哪几片 + 每片取哪段"，流式拼接 | 支持视频拖动、断点续传 |
| 元数据 | **D1**(SQLite) 存文件/分片清单/账号池/用户/日志 | 无服务器、和 Worker 天然绑定 |
| 下载带宽 | R2 **出网流量免费** | 这是它比 S3 香的核心 |
| 账号密钥 | D1 只存**AES-GCM 密文**，主密钥走 `wrangler secret` | 数据库泄露不等于密钥泄露 |
| 前后台 | 后台 = `users` 里的 admin（JWT Cookie）；前台 = **共享访问密码**换一枚只读 `guest` Cookie | 给朋友看文件不用发管理员号，权限在路由层硬分 |

---

## 二、模块分层

```
pan-r2/
├─ wrangler.toml          # 部署配置：D1 / KV / 静态资源 / 变量 / cron
├─ schema.sql             # D1 建表
├─ scripts/
│  ├─ render-config.mjs   # 用环境变量渲染 .wrangler-deploy.toml
│  └─ d1-apply.mjs        # 走 D1 HTTP API 应用 schema.sql
├─ src/
│  ├─ index.ts            # 网络层：路由 + 所有 HTTP handler + scheduled(定时清理)
│  ├─ roles.ts            # 权限层：admin / guest 双身份解析（readAccess / requireAny / requireAdmin）
│  ├─ auth.ts             # 认证：PBKDF2 口令、HS256 JWT、Cookie 会话
│  ├─ ratelimit.ts        # 登录限流：KV 双桶（账号 5 次 / IP 100 次）
│  ├─ crypto.ts           # 账号密钥 AES-GCM 加解密
│  ├─ s3.ts               # 存储适配层：跨账号 R2 的 PUT/GET(Range)/DELETE
│  ├─ store.ts            # 账号池：增删改查、选桶(最空)、记账
│  ├─ chunk.ts            # 分片层：init / putChunk / complete / Range 拼接流
│  ├─ share.ts            # 分享链接：HMAC 签名 token、KV 记录、撤销/限次
│  ├─ sheet.ts            # 在线表格：稀疏单元格存 D1 + 自写公式求值器
│  ├─ doc.ts              # 在线文档：Markdown 存 D1 + 极简渲染
│  ├─ visit.ts            # 访问日志：落 D1、按 IP 聚合、按天清理
│  └─ types.ts / util.ts
└─ web/index.html         # 前端：单文件 SPA（登录 / 文件 / 上传 / 表格 / 文档 / 后台管理）
```

接口与前端分离：`src/` 只认 JSON，前端可以换成任意 Pages 应用，接口不变。

---

## 三、数据模型（schema.sql）

- `accounts`：账号池。`account_id + bucket + access_key_id + secret_access_key(密文)`，`capacity_bytes`(默认 10GB)、`used_bytes`、`enabled`。
- `files`：成品文件。`id`(uuid) / `name` / `size` / `chunk_size` / `chunks_count` / `folder_id`。
- `chunks`：**分片清单**（核心）。`file_id, idx, account_id, bucket, object_key, size, etag`。`UNIQUE(file_id, idx)`。
- `uploads`：未完成的上传会话（可断点续传）。
- `folders` / `users`(`role`, `front_enabled`)。
- `sheets` + `sheet_cells`(PK `sheet_id,r,c`)：在线表格，一格一行，稀疏存储。
- `docs`：在线文档，`content` 是 Markdown 原文，上限 1MB。
- `visits`：访问日志。`ip / country / city / ua / method / path / status / uid / username / referer / created_at`，索引 `(id DESC)` 与 `(ip, id DESC)`。
- `settings`：键值配置（`visit_keep_days`、`last_prune` 等）。

> 关系：一个 file → N 个 chunk → 每个 chunk 指向某个 account 上的一个对象。**文件根本不在一个桶里，是被 chunks 表拼起来的。**

---

## 四、分片上传时序

```
前端                           Worker                          账号池(R2×N)
 │  POST /api/upload/init       │
 │  {name,size} ───────────────▶│ 建 uploads 记录，算出 chunksCount
 │◀──── {uploadId,chunkSize,count}
 │                             │
 │  PUT /api/upload/:id/chunk/0 │ pickAccount(最空) ──PUT──▶ R2-a/u/id/0
 │  (二进制 body) ─────────────▶│ 写 chunks(idx=0, account=a) + 记账
 │  PUT .../chunk/1             │ ──PUT──────────────────▶ R2-b/u/id/1
 │  ...（可并发、可断点重传，已存在则幂等跳过）
 │                             │
 │  POST /api/upload/:id/complete
 │ ───────────────────────────▶│ 校验片数/总大小 → 生成 file → chunks.file_id 改成 file.id
 │◀──────────── {fileId}
```

- 分片大小默认 **16MB**（可 5–100MB 调）。太小→操作数爆炸；太大→单请求内存/超时风险。
- `putChunk` 先 `reserveBytes` 占额再上传，失败回滚，避免超额。
- 同一个 `idx` 重复 PUT 会被 `UNIQUE(file_id,idx)` 挡住，直接返回 skipped —— 天然续传。

---

## 五、下载 / Range 原理（chunk.ts: planRanges + streamDownload）

分片在逻辑上首尾相接，`planRanges` 把字节区间 `[start,end]` 映射成：

```
[{chunk:0, localStart, localEnd}, {chunk:1, ...}, ...]
```

然后 `streamDownload` 用 `ReadableStream` 一片一片 `GET`（带 `Range: bytes=a-b`）推进去，响应头回 `206 + Content-Range`。所以：

- 视频在线播放可以拖动进度条（`/api/files/:id/play` 走 inline，带正确 MIME）；
- 下载器断点续传只回缺失的那几片；
- `Content-Length` 正确，浏览器能显示进度。

**每次请求最多拼 50 片**（免费版每请求 50 个外部子请求，R2 fetch 算外部子请求）。`maxEndForRequest()` 会把一次 Range 夹到 50 片以内，返回 `X-Segment-Next`，前端 `downloadFile()` 用 `showSaveFilePicker` 拿到文件句柄，按 `Content-Range` 一段段续写到磁盘，直到写完整个文件。

---

## 六、认证与权限（前后台分离）

两种身份，两种 Cookie：

| 身份 | 登录方式 | Cookie | 能干什么 |
|---|---|---|---|
| **admin** | 账号 + 密码 → `/api/login` | `sid`（HS256 JWT，12h） | 全部：上传、新建文件夹、加账号、分享、用户、访问日志、改密码 |
| **guest**（前台） | 只输**前台访问密码** → `/api/front/login` | `guest`（JWT，`scope:read`，90 天） | 只读：看目录、看文件、下载、播放、看表格/文档 |

- `src/roles.ts` 里一个 `readAccess(req,env)` 统一解析；读接口走 `requireAny`，写接口一律 `requireAdmin`，非管理员回 **403「只有管理员能做这个操作」**。
- `/api/me` 返回 `can` 位图 `{read,write,manage,accounts,users,logs,shares,password}`，前端据此动态生成侧栏——guest 看到的就只有「文件 / 表格 / 文档」。
- 前台密码就是**第一条 admin 的口令哈希**（后台「用户与密码」页可单独设），所以后台改了它，前台密码同步变。前台限流用固定桶 `front`，不会出现访客之间互相锁。
- 口令 **PBKDF2-SHA256 / 10 万次**哈希存 D1；账号 Access Key 用 **AES-GCM** 加密，主密钥 `MASTER_KEY` 只在 Worker secret。
- **登录失败限流**（`src/ratelimit.ts`）：KV 双层桶，账号桶 `login:u:<sha1(username)>` **5 次**、IP 桶 `login:ip:<sha1(ip)>` **100 次**，窗口 10 分钟。超限 `429`，连正确密码也进不去；登录成功清账号桶、保留 IP 桶。改密码的「旧密码」也记同一个桶。
  手工解锁：删 KV 里那把 key 即可。
- **分享链接**：`src/share.ts` 用 HMAC-SHA256 签 `token=base64url(claims).base64url(sig)`，claims 含 `{f,e,j,d?}`；`/s/:token` 免登录下载页，`?dl=1` 才真正出文件。记录放 KV `share:<jti>`，可撤销 / 限下载次数 / 到期自动清除。
- **务必**：`JWT_SECRET` / `MASTER_KEY` 用 `wrangler secret put`，不要写进 `wrangler.toml` 或仓库。

### 改管理员密码

三种办法，按场景挑：

1. **后台自己改（推荐）**：登录后点导航「我的账号」→ 填当前密码 + 新密码（≥8 位）两次 → 保存。走 `POST /api/password {oldPassword,newPassword}`，验旧密码、`UPDATE users SET pass_hash`、顺手重签一个新 Cookie 给你。
2. **直接改 D1**：拿不到旧密码时用。
   ```bash
   node -e "const c=require('crypto');const salt=c.randomBytes(16);const b=c.pbkdf2Sync('新密码',salt,100000,32,'sha256');const u=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');console.log('pbkdf2$100000$'+u(salt)+'$'+u(b))"
   ```
   ```sql
   UPDATE users SET pass_hash = 'pbkdf2$100000$...$...' WHERE username = 'admin';
   ```
3. **全丢了想重来**：`DELETE FROM users;` 再设 `BOOTSTRAP_ADMIN=admin:新密码` 变量重新部署（`ensureBootstrap` 只在 `users` 为空时建号）。

改完密码不影响已发出的旧 Cookie（JWT 只验签名+过期，旧 cookie 仍能用满 12h）；要立刻踢掉所有会话就换 `JWT_SECRET`。

### 访问日志与自动清理

- 所有 `/api/*` 请求（跳过 `/api/visits` 本身）在响应后由 `ctx.waitUntil(logVisit(...))` 旁路写 D1，不拖慢响应；`LOG_VISITS=0` 可全关。
- 后台「访问日志」页：上半按 IP 聚合（次数/地区/最后访问/是否被锁），下半原始记录，顶部标出「← 你」。
- `wrangler.toml` 里 `[triggers] crons = ["0 4 1,16 * *"]`，每月 1 号与 16 号 04:00 UTC 跑一次 `scheduled()`，按 `VISIT_KEEP_DAYS`（默认 15 天）`pruneVisits`，并把时间写进 `settings.last_prune`。后台也能点「立即清理」。

---

## 七、在线表格与在线文档

- **表格**（`src/sheet.ts`）：真的电子表格，不是玩具。单元格稀疏存储（一格一行），204 列上限、5000 行。
  公式求值是**手写的递归下降解析器**：支持 `+ - * /`、括号、单元格引用（`B2`、`$B$2`）、区间（`A1:C3`）以及 `SUM / AVG / AVERAGE / MIN / MAX / COUNT`。**绝不 `eval` 用户输入的字符串**。
  `saveSheet` 整片 `DELETE` 再批量 `INSERT`（按 24 条一组塞进 D1 batch），一次保存一个事务语义。还支持 TSV/CSV 粘贴导入（自动识别分隔符与双引号转义）。导出走 `/api/sheets/:id/export`，导出的是**求值后的结果**。
- **文档**（`src/doc.ts`）：Markdown 原文存 D1（单篇 1MB 上限），编辑页左写右预览（`Ctrl+S` 保存）；`/api/docs/:id?view=1` 输出一个渲染好的深色静态页，可以直接发给别人看；`?raw=1` 取纯文本。
  Markdown 渲染是自己写的极简实现（标题 / 列表 / 代码块 / 粗斜体 / 行内码 / 链接 / 引用 / 分隔线），不引第三方库。

---

## 八、部署步骤

```bash
cd pan-r2
npm install
npx wrangler login

# 1) 建 D1 与 KV，把返回的 id 填进 wrangler.toml
npx wrangler d1 create pan_r2
npx wrangler kv:namespace create PAN_R2_KV

# 2) 建表
npx wrangler d1 execute pan_r2 --file=schema.sql --remote
#    或者用 HTTP API（CI 里更方便）：
#    CF_TOKEN=... CF_ACCOUNT_ID=... D1_ID=... node scripts/d1-apply.mjs

# 3) 设置密钥（务必换掉默认值）
npx wrangler secret put JWT_SECRET
npx wrangler secret put MASTER_KEY

# 4) 部署（含静态前端）
npx wrangler deploy
```

> 已有库升级时注意：`CREATE TABLE IF NOT EXISTS` **不会给已存在的表加列**。像后来加的 `users.front_enabled` 必须单独 `ALTER TABLE users ADD COLUMN front_enabled INTEGER NOT NULL DEFAULT 1`，否则报 `D1_ERROR: no such column: front_enabled`。

部署后打开 Worker 域名，用 `BOOTSTRAP_ADMIN` 里的账号登录（之后建议清空该变量），进后台加账号：

```bash
# 每个 CF 账号：控制台 → R2 → Manage R2 API Tokens → 建 S3 凭证
# 拿到 Access Key ID / Secret Access Key / Account ID / 桶名，POST 进来
curl -X POST https://<你的域名>/api/accounts \
  -b "sid=<登录后的cookie>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"账号A","account_id":"<CF Account ID>","bucket":"pan-a",
       "access_key_id":"<AK>","secret_access_key":"<SK>",
       "capacity_bytes":10737418240}'
```

加够账号后，前端顶部就会显示 `N 账号 / 总容量`，和截图一样的观感。

然后在「用户与密码」页设一个**前台访问密码**（可以和后台不同），把域名 + 这个密码发给朋友，他们就能只读浏览。

### 能不能用 CF 环境变量改掉 `REPLACE_WITH_D1_ID` / `REPLACE_WITH_KV_ID` / `BOOTSTRAP_ADMIN`？

分两类，答案不一样：

| 配置 | 能不能走环境变量 | 原因 |
|---|---|---|
| `database_id` / `kv id` | **不能（运行时）** | 这是**部署期绑定**（binding），`wrangler deploy` 时写进 Worker 配置。控制台的 Variables 只能塞运行时 `env`，改不了绑定。但可以在部署前用脚本从环境变量注进 toml —— 见下。 |
| `BOOTSTRAP_ADMIN` / `PUBLIC_APP_NAME` / `LOG_VISITS` / `VISIT_KEEP_DAYS` | **能** | `[vars]` 就是运行时 `env`：`wrangler.toml`、控制台 Settings → Variables、或 `wrangler secret put`（推荐，不进仓库） |

渲染脚本把 id 从环境变量注进配置再部署：

```bash
export D1_DATABASE_ID=<wrangler d1 create 返回的 uuid>
export KV_NAMESPACE_ID=<wrangler kv namespace create 返回的 id>
export BOOTSTRAP_ADMIN='admin:换成你的密码'   # 可选，不传就沿用 toml 里的

npm run deploy:env
# 等价于：node scripts/render-config.mjs && wrangler deploy --config .wrangler-deploy.toml
```

`scripts/render-config.mjs`：读 `wrangler.toml` → 替换 id 和 vars → 二次校验没有残留 `REPLACE_WITH_` → 写 `.wrangler-deploy.toml`（已在 `.gitignore`）。

CI 里就三行：

```yaml
- run: npm ci
- run: npx wrangler d1 execute pan_r2 --file=schema.sql --remote
  env: { CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}, CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }} }
- run: npm run deploy:env
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
    D1_DATABASE_ID: ${{ secrets.D1_DATABASE_ID }}
    KV_NAMESPACE_ID: ${{ secrets.KV_NAMESPACE_ID }}
    BOOTSTRAP_ADMIN: ${{ secrets.BOOTSTRAP_ADMIN }}
```

---

## 九、本地开发

```bash
npm run db:init:local     # 本地 D1 建表
npm run dev               # wrangler dev，本地起 Worker
npm run typecheck         # tsc --noEmit 检查类型
```

本地 `wrangler.toml` 不配 `MASTER_KEY` 时会退化成 `plain:base64` 存密钥，**只用于本地**。

前端是单文件 `web/index.html`（内联 CSS/JS，无构建步骤）。改完可以这样快速语法检查：

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('web/index.html','utf8');fs.writeFileSync('dist/_web.js',/<script>([\s\S]*)<\/script>/.exec(h)[1])" && node --check dist/_web.js
```

---

## 十、扩展方向

- **上传会话用 Durable Object**：并发分片抢同一账号时做原子配额，避免 D1 记账竞态。
- **分片加密**：前端流式 AES-GCM 加密后再上传，元数据存每片 IV；网盘侧看不到明文。
- **冷热分层**：小文件/热文件留前几个账号，大文件往尾部账号堆。
- **复制/冗余**：关键文件跨账号存两份，`chunks` 加 `replica_of`。
- **回收站**：删除改软删，定时任务清理 R2 对象与配额。

---

## 十一、160GB 文件夹 / 16K 长视频会怎么跑

先给结论：**能存能取，但要按 CF 的硬限额拆开跑**。核心三个数（docs 实测）：

| 限额 | 值 | 影响 |
|---|---|---|
| 请求体上限（看域名套餐） | Free/Pro 100MB、Business 200MB、Enterprise 500MB（可调 5GB） | **单片必须 ≤100MB**，现有 16–64MB 分片天然合规 |
| Worker 内存 | 128MB / isolate | 单片别超 ~100MB，否则 `arrayBuffer()` 就爆 |
| 每请求外部子请求 | 免费 50 / 付费默认 10000（可调至千万） | **一次下载请求最多拼 50 片**，大文件必须前端分段续拉 |
| R2 单对象 / 单次 PUT | 5TiB / 5GiB | 单片 PUT 远没到顶，没问题 |

### 160GB 文件夹（很多文件）
- 目录里每个文件各自开一个 upload 会话，互不影响；总容量按 ~10GB/账号算，**至少 16 个账号**，留余量配 20 个。
- 单文件 160GB：64MB 分片 → **2560 片**；每片 1 次 PUT（各自独立请求，不冲突）。
- D1 记账：2560 次 `chunks` 插入 + 2560 次配额更新 ≈ 5k 行写，免费额度（10 万行/天）够，但**别一天来回重传**。
- 上传并发前端限 3，断点续传靠 `UNIQUE(file_id,idx)` 幂等跳过。

### 16K 长视频（单个超大文件）
同一个文件，结论只落在两点上：**分片数**和**下载分期**。16K 视频本身不影响传输（Worker 只看字节），但它意味着码率高、单文件大——按 64MB 分片、每请求 50 片算，一次下载请求推 **3.2GB**，一个 160GB 文件要 **50 次** HTTP 往返，前端就是这么分段的。播放另说：浏览器能不能硬解 16K 是客户端的事，网盘只保证 `Range` 正确。

### 分段下载（已内置）
`GET /api/files/:id/download` 收到大 Range 会被 `maxEndForRequest()` 夹到 50 片，回 `206` + `X-Segment-Next`；前端读到 `Content-Range` 的尾字节就接着发下一段，直到写满。

---

## 十二、12GB 电影能直接播吗 / Emby 能不能上 CF

### 12GB 单文件直接播放：能，但有前提
- 分片任意大都能拼起来播，但**浏览器只能解它自带解码器支持的容器+编码**：**MP4 + H.264/AAC + `faststart`**（`moov` 在文件头）才能边下边播、拖进度条。
- MKV 容器、HEVC/H.265、DTS 音轨浏览器多半放不了——不是网盘的问题，是播放器不支持。
- 转封装：`ffmpeg -i in.mkv -c copy -movflags +faststart out.mp4`。
- 超过 2GB 的请求：已被 50 片/请求夹断，前端自动分段，播放器走 Range 拖动时同样受这个约束。

### Emby 部署到 Cloudflare：不现实
Emby 是 .NET 服务，要持久进程、要本地磁盘存元数据和转码缓存、要 ffmpeg；Workers 是无状态 isolate、128MB 内存、没有本地盘。勉强能跑的只有「静态前端 + API 网关」，媒体服务本体不行。

---

## API 一览

公开（免登录）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/login` | 管理员登录 `{username,password}` |
| POST | `/api/front/login` | 前台访问密码登录 `{password}` |
| POST | `/api/logout` | 清 Cookie |
| GET | `/api/me` | 当前身份 + `can` 权限位图 |
| GET | `/s/:token` | 分享页（`?dl=1` 出文件） |
| GET | `/api/public/info?token=` | 分享信息 |

读（admin 或 guest）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/stats` | 账号数/总容量/已用/文件数 |
| GET | `/api/tree` | 目录 + 文档 + 表格混排 |
| GET | `/api/folders` · `/api/files?folder=` | 目录 / 文件列表 |
| GET | `/api/files/:id/download` | 下载（Range，超 50 片自动分期） |
| GET | `/api/files/:id/play` | 内联播放（正确 Content-Type + inline） |
| GET | `/api/sheets` · `/api/sheets/:id` · `/:id/export` | 表格列表 / 内容 / 导出 TSV |
| GET | `/api/docs` · `/api/docs/:id` | 文档列表 / 内容（`?raw=1` 纯文本，`?view=1` 渲染页） |

写（仅 admin）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST/PATCH/DELETE | `/api/folders[/:id]` | 新建 / 改名 / 删除（非空拒 409） |
| POST | `/api/upload/init` | 开上传会话 |
| PUT | `/api/upload/:id/chunk/:idx` | 传一片 |
| POST | `/api/upload/:id/complete` | 收尾成文件 |
| DELETE | `/api/files/:id` | 删除（连带清 R2 分片） |
| POST | `/api/files/:id/share` | 生成签名分享链接（`ttlSec` / `maxDownloads`） |
| GET/DELETE | `/api/shares[/:jti]` | 分享列表 / 撤销 |
| GET/POST/PATCH/DELETE | `/api/accounts[/:id]` | 账号池 CRUD |
| POST | `/api/accounts/:id/test` | 测桶连通（`s3HeadBucket`） |
| GET/POST/PATCH/DELETE | `/api/users[/:id]` | 用户（不许降级/删除最后一个 admin） |
| POST | `/api/front/password` | 设前台访问密码 |
| POST | `/api/password` | 改自己的密码 |
| GET | `/api/visits?limit&offset&summary=1` | 访问日志 |
| POST | `/api/visits/prune` | 立即清理 `{days}` |
| GET | `/api/locks?u=&ip=` | 查某账号/IP 是否被锁 |
