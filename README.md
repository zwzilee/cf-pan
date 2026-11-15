# PAN R2 — 多 Cloudflare 账号 R2/S3 聚合网盘

把几十个 Cloudflare 账号的 R2 免费桶（每个 10GB）拼成一个统一网盘，Worker 部署、前后台双密码、大文件分片存、下载支持 Range 断点续传。

> 截图里 `70 账号 / 665GB / <1%` 就是这个思路：70 × ~9.5GB 实际可用 ≈ 665GB，一个前端看过去像一块大硬盘。

---

## 一、为什么这么设计（关键决策）

| 问题 | 做法 | 原因 |
|---|---|---|
| 跨账号读写 R2 | **走 S3 兼容 API**（`aws4fetch` 签名），`https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>` | Worker 的 `R2Bucket` binding 只能访问**本账号**，池子里别的账号必须用 S3 Access Key |
| 大文件 | **自己切分片**，每片是一个独立对象，落在不同账号 | R2 的 multipart 要求所有 part 在同一对象/桶；要"摊到多个账号"只能应用层分片 |
| 分片怎么摊 | 每片选**剩余空间最大**的可用账号 | 自动均衡，别把某个桶写满 |
| 下载 | Worker 按 Range 定位到"哪几片 + 每片取哪段"，流式拼接 | 支持视频拖动、断点续传 |
| 元数据 | **D1**(SQLite) 存文件/分片清单/账号池/用户 | 无服务器、和 Worker 天然绑定 |
| 下载带宽 | R2 **出网流量免费** | 这是它比 S3 香的核心 |
| 账号密钥 | D1 只存**AES-GCM 密文**，主密钥走 `wrangler secret` | 数据库泄露不等于密钥泄露 |

---

## 二、模块分层

```
pan-r2/
├─ wrangler.toml          # 部署配置：D1 / KV / 静态资源 / 变量
├─ schema.sql             # D1 建表
├─ src/
│  ├─ index.ts            # 网络层：路由 + 所有 HTTP handler
│  ├─ auth.ts             # 认证：PBKDF2 口令、HS256 JWT、Cookie 会话
│  ├─ crypto.ts           # 账号密钥 AES-GCM 加解密
│  ├─ s3.ts               # 存储适配层：跨账号 R2 的 PUT/GET(Range)/DELETE
│  ├─ store.ts            # 账号池：增删改查、选桶(最空)、记账
│  ├─ chunk.ts            # 分片层：init / putChunk / complete / Range 拼接流
│  ├─ share.ts            # 分享链接：HMAC 签名 token、KV 记录、撤销/限次
│  └─ types.ts / util.ts
└─ web/index.html         # 前端：登录、文件列表、拖拽分片上传、下载
```

对应你截图那套 UI 的后端就是 `src/`，前端可以换成任意 Pages 应用，接口不变。

---

## 三、数据模型（schema.sql）

- `accounts`：账号池。`account_id + bucket + access_key_id + secret_access_key(密文)`，`capacity_bytes`(默认 10GB)、`used_bytes`、`enabled`。
- `files`：成品文件。`id`(uuid) / `name` / `size` / `chunk_size` / `chunks_count` / `folder_id`。
- `chunks`：**分片清单**（核心）。`file_id, idx, account_id, bucket, object_key, size, etag`。`UNIQUE(file_id, idx)`。
- `uploads`：未完成的上传会话（可断点续传）。
- `folders` / `users`。

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

- 视频在线播放可以拖动进度条；
- 下载器断点续传只回缺失的那几片；
- `Content-Length` 正确，浏览器能显示进度。

---

## 六、认证与安全

- **双密码**：前端访问密码 + 管理后台密码，都是 `users` 表里的账号（`role`: admin/user）。首次部署用 `BOOTSTRAP_ADMIN=admin:密码` 自动建管理员，之后删掉该变量。
- 口令用 **PBKDF2-SHA256 / 10 万次**哈希存 D1，不存明文。
- 登录签发 **HS256 JWT** 放 HttpOnly Cookie，12h 过期。
- 账号 Access Key 用 **AES-GCM** 加密存 D1，主密钥 `MASTER_KEY` 只在 Worker secret 里。
- 建议再加：登录失败限流（KV 计数）。
- **分享链接**：`src/share.ts` 用 HMAC-SHA256 签 `token=base64url(claims).base64url(sig)`，claims 含 `{f,e,j,d?}`；`/s/:token` 免登录下载页，`?dl=1` 才真正出文件。记录放 KV `share:<jti>`，可撤销 / 限下载次数 / 到期自动清除。
- **务必**：`JWT_SECRET` / `MASTER_KEY` 用 `wrangler secret put`，不要写进 `wrangler.toml` 或仓库。

### 改管理员密码

三种办法，按场景挑：

1. **后台自己改（推荐）**：登录后点导航「我的账号」→ 填当前密码 + 新密码（≥8 位）两次 → 保存。走 `POST /api/password {oldPassword,newPassword}`，验旧密码、`UPDATE users SET pass_hash`、顺手重签一个新 Cookie 给你。命令行等价：

   ```bash
   curl -c c.txt -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"旧密码"}' \
     https://pan-r2.isophia1205.workers.dev/api/login
   curl -b c.txt -H 'Content-Type: application/json' \
     -d '{"oldPassword":"旧密码","newPassword":"新密码至少8位"}' \
     https://pan-r2.isophia1205.workers.dev/api/password
   ```

2. **忘掉旧密码了 → 直接改 D1 里那行**。先把新密码算成哈希（`auth.ts` 的 `hashPassword`，PBKDF2-SHA256/10 万次，格式 `pbkdf2$100000$salt$hash`），本机用 Node 一条命令出：

   ```bash
   node -e "const c=require('crypto');const salt=c.randomBytes(16);const b=c.pbkdf2Sync('新密码',salt,100000,32,'sha256');const u=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');console.log('pbkdf2\$100000\$'+u(salt)+'\$'+u(b))"
   ```

   然后把哈希塞进 D1（控制台 D1 → `pan_r2` → Console，或 `wrangler d1 execute`）：

   ```sql
   UPDATE users SET pass_hash = 'pbkdf2$100000$...$...' WHERE username = 'admin';
   ```

   全丢了想重来一遍：`DELETE FROM users;` 再设 `BOOTSTRAP_ADMIN=admin:新密码` 变量重新部署（`ensureBootstrap` 只在 `users` 为空时建号）。

3. **想加第二个低权限账号**：往 `users` 插一行 `role='user'`，前端访问密码就是它。

改完密码会影响所有已发出的旧 Cookie，但 JWT 只验签名+过期，所以旧 cookie 仍能用满 12h；要立刻踢掉全部会话就换掉 `JWT_SECRET`（`wrangler secret put JWT_SECRET`），代价是所有人都得重新登录。

---

## 七、部署步骤

```bash
cd pan-r2
npm install

npx wrangler login

# 1) 建 D1 与 KV，把返回的 id 填进 wrangler.toml
npx wrangler d1 create pan_r2
npx wrangler kv:namespace create PAN_R2_KV

# 2) 建表
npx wrangler d1 execute pan_r2 --file=schema.sql --remote

# 3) 设置密钥（务必换掉默认值）
npx wrangler secret put JWT_SECRET
npx wrangler secret put MASTER_KEY

# 4) 部署
npx wrangler deploy
```

部署后打开 Worker 域名，用 `BOOTSTRAP_ADMIN` 里的账号登录，进后台加账号：

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

### 能不能用 CF 环境变量改掉 `REPLACE_WITH_D1_ID` / `REPLACE_WITH_KV_ID` / `BOOTSTRAP_ADMIN`？

分两类，答案不一样：

| 配置 | 能不能走环境变量 | 原因 |
|---|---|---|
| `database_id` / `kv id` | **不能** | 这是**部署期绑定**（binding），`wrangler deploy` 时写进 Worker 配置。控制台的 Variables 只能塞运行时 `env`，改不了绑定。id 也不该当密钥藏，它本来就是配置。 |
| `BOOTSTRAP_ADMIN` / `PUBLIC_APP_NAME` | **能** | `[vars]` 就是运行时 `env`，三种途径都行：`wrangler.toml`、控制台 Settings → Variables and Secrets、`wrangler secret put BOOTSTRAP_ADMIN`（推荐，不进仓库） |

所以给了一个渲染脚本，把 id 从环境变量注进配置再部署，避免手改 toml：

```bash
# D1 / KV 的 id 从环境变量来
export D1_DATABASE_ID=<wrangler d1 create 返回的 uuid>
export KV_NAMESPACE_ID=<wrangler kv namespace create 返回的 id>
export BOOTSTRAP_ADMIN='admin:换成你的密码'   # 可选，不传就沿用 toml 里的

npm run deploy:env
# 等价于：node scripts/render-config.mjs && wrangler deploy --config .wrangler-deploy.toml
```

`scripts/render-config.mjs` 会：读 `wrangler.toml` → 替换 id 和 vars → 二次校验没有残留 `REPLACE_WITH_` → 写 `.wrangler-deploy.toml`（已在 `.gitignore`，不会进仓库）。

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

> `BOOTSTRAP_ADMIN` 只在 `users` 表为空时生效（`ensureBootstrap` 先查 `COUNT(*)`），建过管理员后再留着也无害；但**建完建议删掉**，改密码走后台。密钥类的 `JWT_SECRET` / `MASTER_KEY` 一律 `wrangler secret put`，永远别写进 toml。

---

## 八、本地开发

```bash
npm run db:init:local     # 本地 D1 建表
npm run dev               # wrangler dev，本地起 Worker
npm run typecheck         # tsc --noEmit 检查类型
```

本地 `wrangler.toml` 不配 `MASTER_KEY` 时会退化成 `plain:base64` 存密钥，**只用于本地**。

---

## 九、扩展方向

- **上传会话用 Durable Object**：并发分片抢同一账号时做原子配额，避免 D1 记账竞态。
- **分片加密**：前端流式 AES-GCM 加密后再上传，元数据存每片 IV；网盘侧看不到明文。
- **冷热分层**：小文件/热文件留前几个账号，大文件往尾部账号堆。
- **复制/冗余**：关键文件跨账号存两份，`chunks` 加 `replica_of`。
- **回收站**：删除改软删，定时任务清理 R2 对象与配额。

---

## 十、160GB 文件夹 / 16K 长视频会怎么跑

先给结论：**能存能取，但要按 CF 的硬限额拆开跑**。核心三个数（docs 实测）：

| 限额 | 值 | 影响 |
|---|---|---|
| 请求体上限（看域名套餐） | Free/Pro 100MB、Business 200MB、Enterprise 500MB（可调 5GB） | **单片必须 ≤100MB**，现有 16–64MB 分片天然合规 |
| Worker 内存 | 128MB / isolate | 单片别超 ~100MB，否则 `arrayBuffer()` 就爆 |
| 每请求外部子请求 | 免费 50 / 付费默认 10000（可调至千万） | **一次下载请求最多拼 50 片**，大文件必须前端分段续拉 |
| R2 单对象 / 单次 PUT | 5TiB / 5GiB | 单片 PUT 远没到顶，没问题 |

### 160GB 文件夹（很多文件）
- 目录里每个文件各自开一个 upload 会话，互不影响；总容量按 ~10GB/账号算，**至少 16 个账号**，留余量配 20 个。
- 单文件 160GB：64MB 分片 → **2560 片**；每片 1 次 PUT（1 个外部子请求，各自是独立请求，不冲突）。
- D1 记账：2560 次 `chunks` 插入 + 2560 次 `accounts` 配额更新 ≈ 5k 行写，免费额度（10 万行/天）够，但**别一天来回重传**。
- 上传并发前端限 3，断点续传靠 `UNIQUE(file_id,idx)` 幂等跳过。

### 16K 长视频（单个超大文件）
- **存储/下载没问题**：一片片摊到池子里的账号，`chunks` 表拼回来，单对象远没到 5TiB。
- **网页里直接播不行**：浏览器解不了 16K、单个 Range 请求又超 50 片上限。两条路：
  1. 只做**下载 / 归档**（推荐）：走分段下载（见下），拉到本地再用本地播放器。
  2. 要在线看：先离线用 ffmpeg 转成 **HLS**（小分片 + m3u8），把每段当普通文件上传，前端用 hls.js 播放 —— 每段都很小，天然绕开子请求上限。

### 分段下载（已内置）
`serveFile` 里 `maxEndForRequest(chunks,start)` 把一次响应夹到最多 `MAX_PARTS_PER_REQUEST=50` 片，返回 `206 + Content-Range + X-Segment-Next`；前端 `downloadFile()` 用 `showSaveFilePicker` 边拉边写盘，按 `Content-Range` 的 `end` 一段段续到文件尾：
- 不整文件进内存，160GB 也是流式落盘；
- 免费版 50 片一档自动续；付费版把常量调大（如 10000）就少绕几趟；
- 不支持 File System Access 的浏览器退回原生 `<a>` 下载，靠浏览器自己发 Range。

> 想再快：`wrangler.toml` 加 `[limits] subrequests = 10000`（付费），并把 `MAX_PARTS_PER_REQUEST` 调高，单请求能一次拼更多片。

---

## 十一、12GB 电影能直接播吗 / Emby 能不能上 CF

### 12GB 单文件直接播放：能，但有前提
12GB / 64MB = **192 片**，存储没问题。新增 `GET /api/files/:id/play`（`serveFile(...,{inline:true})`，回正确 `Content-Type` + `inline`，仍支持 Range 拖动）。要流畅直放还需：

| 前提 | 说明 |
|---|---|
| 容器/编码 | **MP4 + H.264 + AAC** 浏览器原生能放；MKV / HEVC / 部分 10bit 放不了 |
| faststart | moov 必须在文件头：`ffmpeg -i in.mkv -c copy -movflags +faststart out.mp4`，否则首帧要等整文件 |
| Range | 已支持；单请求夹到 50 片≈3.2GB，`<video>` 会按 `Content-Range` 继续要，拖动可用 |
| 套餐 | 免费版 CPU 10ms 边转流偏紧，正式看片建议付费版 |

一句话：**H.264 的 mp4 直接播没问题；mkv/hevc 先 remux/转码。**

### Emby 部署到 Cloudflare：不现实
- **Workers 跑不了 Emby**：V8 isolate，没有 .NET 运行时、没有持久磁盘、128MB 内存、CPU 限时，也没有 ffmpeg。
- **Cloudflare Containers 也不合适**：磁盘是临时的、没有 FUSE（rclone mount 起不来）、实例会休眠、没 GPU 转码，入口还得经 Worker。
- **可行的是「VPS/NAS 跑 Jellyfin/Emby，媒体库指向 R2」**：但本项目跨账号分片后，单个文件不是一个桶里的对象，标准文件系统看不到。需要先在 Worker 上加一层 **WebDAV / S3 读 facade**（读时把 chunks 重组成一条流），VPS 上 `rclone mount` 成目录，再让 Jellyfin/Emby 当本地盘读。
- **更省事的两条**：① 媒体直接存单对象（R2 付费超 10GB 也就 $0.015/GB/月），rclone 直挂即可；② 用 **Cloudflare Stream** 托管转码出 HLS，播放器直接放，代价是按分钟计费。

---

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 账号密码换 Cookie |
| GET | `/api/me` | 当前身份 |
| GET | `/api/stats` | 账号数/总容量/已用/文件数 |
| GET/POST | `/api/accounts` | 账号池列表 / 新增（管理员） |
| PATCH/DELETE | `/api/accounts/:id` | 改容量/启停/换密钥 / 删除 |
| POST | `/api/accounts/:id/test` | 测桶连通（s3HeadBucket） |
| GET/POST | `/api/folders` | 目录 |
| GET | `/api/files?folder=` | 文件列表 |
| POST | `/api/upload/init` | 开上传会话 |
| PUT | `/api/upload/:id/chunk/:idx` | 传一片 |
| POST | `/api/upload/:id/complete` | 收尾成文件 |
| GET | `/api/files/:id/download` | 下载（支持 Range，超 50 片自动分期） |
| GET | `/api/files/:id/play` | 内联播放（正确 Content-Type + inline，支持拖动） |
| POST | `/api/files/:id/share` | 生成签名分享链接（ttlSec/maxDownloads） |
| GET | `/api/shares` | 有效分享列表（管理员） |
| DELETE | `/api/shares/:jti` | 撤销分享 |
| GET | `/s/:token` · `/api/public/info?token=` | 公开分享页 / 分享信息（免登录） |
| DELETE | `/api/files/:id` | 删除（连带清 R2 分片） |
