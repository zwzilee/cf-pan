# PAN R2 — 多 Cloudflare 账号 R2/S3 聚合网盘

把几十个 Cloudflare 账号的 R2 免费桶（每个 10GB）拼成一个统一网盘，Worker 部署、前后台双密码、大文件分片存、下载支持 Range 断点续传，自带在线表格与在线文档。

> 截图里 `70 账号 / 665GB / <1%` 就是这个思路：70 × ~9.5GB 实际可用 ≈ 665GB，一个前端看过去像一块大硬盘。

线上实例：<https://pan-r2.isophia1205.workers.dev>

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ikiiing/CF-R2PAN)

> 一键部署按钮**私库也能用**——前提是你自己点、且 Cloudflare Workers & Pages GitHub App 已授权这个仓库，详见「八、部署步骤 → 方式一」。
>
> 🔑 **权限全表见 [PERMISSIONS.md](./PERMISSIONS.md)**：R2 凭证、部署令牌、运维令牌、GitHub Actions、Telegram、Worker 运行时绑定，要开哪些、不要开哪些、每条权限组 id 都在那里面。

---

## 零、先拿 R2 凭证并接上账号（第一次部署必读）

这一步没做，网盘能打开但一个字节也存不了。整个过程 5 分钟。

### 0.1 建桶

Cloudflare 控制台 → 左侧 **存储和数据库 → R2 对象存储** → **创建存储桶**。
名字随便（本文示例 `pan`），位置选离你近的（亚洲用户选 **亚太地区 APAC**）。
R2 必须先开通：首次进 R2 页面会要求绑卡，免费额度 10GB/月不扣钱。

### 0.2 拿 Access Key ID 和 Secret Access Key

这是本项目唯一必须的两个凭证 —— 没有它们，Worker 连不上桶。

**方式 A：建一对专用 S3 凭证（推荐）**

1. R2 概览页右侧 → **Manage R2 API Tokens**（管理 R2 API 令牌）
2. **Create API token**（创建 API 令牌）
3. Token name 随便填，例如 `pan-r2`
4. Permissions 选 **Object Read & Write**（对象读取和写入）
5. 下面 **Specify bucket**（指定存储桶）勾上你刚建的桶（例如 `pan`）——**别给全部桶**，最小权限
6. TTL 留永久，点创建
7. 页面**只显示这一次**，抄下两串：
   - **Access Key ID** —— 形如 `6f34ccbc18adf024e802a1d9ee2ce4f6`（32 位十六进制）
   - **Secret Access Key** —— 形如 `b4554c5074f9df11…`（64 位十六进制，页面下半部分那串）
   - 关掉页面就再也看不到了；丢了只能删了重建

**方式 B：复用账号级 API 令牌（省一步，权限大）**

R2 的 S3 凭证规则：`Access Key ID = 令牌 ID`，`Secret Access Key = sha256(令牌明文)`。

```bash
export CF_TOKEN=cfat_xxxxxxxx          # 你的账号级 API 令牌
# 令牌 ID：GET /accounts/<ACCOUNT_ID>/tokens 里那条的 id
printf %s "$CF_TOKEN" | sha256sum      # 输出就是 Secret Access Key
```

前提：这条令牌要带 `Workers R2 Storage Read` + `Workers R2 Storage Write` 两个权限组。
注意 CF 的 `r2/api_tokens` 路由**不认**账号级令牌（返回 `404 No route matches this url`），别去那儿建。

### 0.3 还要准备三个值

| 值 | 在哪看 | 长什么样 |
|---|---|---|
| **Account ID** | R2 桶详情页「S3 API」那一行取域名前缀；或控制台右侧栏「账户 ID」 | `6e9cf67839f8b1931a7cda49315bc975` |
| **桶名** | 你 0.1 建的 | `pan` |
| **S3 端点** | 自动拼：`https://<Account ID>.r2.cloudflarestorage.com/<桶名>` | — |

### 0.4 填进账号池

部署好、用管理员登录后 → 左侧 **账号池** → **＋ 添加账号**：

```
名称             主账号（随便起，自己认得出就行）
桶名             pan
Cloudflare Account ID   6e9cf67839f8b1931a7cda49315bc975
Access Key ID    6f34ccbc18adf024e802a1d9ee2ce4f6
Secret Access Key  （0.2 抄下来的 64 位）
配额 (GB)        10
```

保存后点那一行的 **测连通** —— 回「连通正常」就说明签名、桶名、Account ID 三者全对。
返回 403 / 签名错误，九成是 Secret 抄漏或抄错了一位；返回 404，多半是桶名或 Account ID 写错。

> Secret 会用 `MASTER_KEY` 加密后入库（`enc:...`），没配 `MASTER_KEY` 则是 `plain:base64`。想真正安全就配一个：
> `npx wrangler secret put MASTER_KEY`（任意 32 字节 base64 串）。

### 0.5 多个账号就重复 0.1–0.4

每个 R2 账号各建一个桶、各建一对凭证，加进同一个账号池。分片时会自动挑剩余空间最大的那个落盘。

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
│  ├─ share.ts            # 分享链接：8 位短码 + KV 记录、撤销/限次
│  ├─ sheet.ts            # 在线表格：稀疏单元格存 D1 + 自写公式求值器
│  ├─ doc.ts              # 在线文档：Markdown 存 D1 + 极简渲染
│  ├─ visit.ts            # 访问日志：落 D1、按 IP 聚合、按天清理
│  ├─ tokens.ts           # API 令牌：sha256 存库、read/manage 两种范围
│  ├─ tg.ts               # Telegram 上传渠道：webhook 收文件、分片入库
│  ├─ dav.ts              # WebDAV 网关：目录挂载 + 临时密钥 + 全套 DAV 方法
│  ├─ files.ts            # 文件删除：blob 引用计数回收 + 配额退还（面板/DAV 共用）
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

### 内容寻址去重（一份内容只存一次）

每片落盘前先算 `sha256(内容)`，拿它当主键查 `blobs` 表：

```
PUT chunk  ──▶ sha256(body) ──▶ blobs 里有这个 hash？
                                  ├─ 有 → refs+1，chunks 指向已有对象，一个字节都不写
                                  └─ 无 → 挑最空账号 PUT 到 b/<前2位>/<hash>，插 blobs(refs=1)
```

- 对象键不再按 `u/<uploadId>/<idx>` 命名，改成 `b/<hash 前两位>/<hash>` —— 同样内容永远同一个键，天然幂等。
- 存 10 份同一部电影：R2 里只有一份，`used` 只涨一份。`/api/stats` 返回 `dedupSaved = 名义体积 − 实际落盘`，页面顶部「♻️ 去重省下」就是这个数。
- 删文件时**不直接删对象**，而是把 `blobs.refs` 减一；减到 0 才真删 R2 对象并退还配额。所以删 A 文件时如果 B 文件还引用着同一片，空间不会掉。
- 分片边界影响命中率：同样内容只要有一片边界错开就整片都算新的。这也是分片大小要固定（同尺寸文件用同一个 chunkSize）的原因。
- 老数据（去重上线前传的）`chunks.hash` 为 NULL，删除时走旧的「按 object_key 直删」分支，不影响。

---

## 五、下载 / Range 原理（chunk.ts: planRanges + streamDownload）

分片在逻辑上首尾相接，`planRanges` 把字节区间 `[start,end]` 映射成：

```
[{chunk:0, localStart, localEnd}, {chunk:1, ...}, ...]
```

然后 `streamDownload` 用 `ReadableStream` 一片一片 `GET`（带 `Range: bytes=a-b`）推进去，响应头回 `206 + Content-Range`。所以：

- 视频在线播放可以拖动进度条（`/api/files/:id/play` 走 inline，带正确 MIME）；
- 图片点「预览」开灯箱，点图 1:1 放大，Esc 关闭；视频播放失败时页面会给「试播前 3 分钟」（`/api/files/:id/preview` 只吐开头 256MB）和「下载看全片」两个出口；
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
- **分享链接**：`src/share.ts` 现在发**8 位短码**（字母表去掉 0/O/1/l/I，≈45 bit 熵），链接形如 `/s/HZKmxdc7`，全长 40 来个字符；文件 id、过期时间、限次都不进 URL，全放 KV `share:<code>`（`{fileId,max,used,exp}`，带 TTL 自动过期）。`/s/:code` 免登录下载页，`?dl=1` 才真正出文件；撤销=删 KV 那条，限次=读时自增。老的长链接（`base64url(claims).base64url(sig)`，HMAC-SHA256 签）仍然认，走 `verifyShareToken` 的兼容分支。
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

### API 令牌（无面板管理）

后台「API 令牌」页可以签发两种令牌，给命令行、脚本、CI 用，不用走浏览器登录：

| 范围 | 能干什么 |
| --- | --- |
| `read` | 只读：`/api/stats`、`/api/files`、`/api/tree`、`/api/sheets`、`/api/docs`、下载 / 播放 |
| `manage` | 读写全管：上传、删文件、账号池、分享、用户、日志、令牌本身 |

#### 1. 拿一个令牌

后台 → 左侧「管理 → API 令牌」→「＋ 管理令牌」→ 起个名字（例如 `ci-deploy`）→ 确定。

页面上会弹出一张绿框，里面是 `pan_` 开头的 51 位字符串（`pan_` + 48 位 hex），旁边有「复制」按钮。**这串明文只显示这一次**：关掉卡片就再也看不到，只能删了重建。

- 库里存的是 `sha256(令牌)`（`src/tokens.ts`），从 D1 里翻不出原文。
- 列表里能看到的只有前缀（前 12 位，`pan_09fafdf4…`），够你认出是哪一条。
- 每条都能「停用」（`enabled=0`，立刻失效，随时能再开）或「删除」（永久）。
- 「最后使用」一列会跟着刷新，用来判断某个令牌还有没有人在用。

#### 2. 怎么带

只有一条规则：放进请求头 `Authorization: Bearer <令牌>`。

```bash
export PAN=https://pan-r2.isophia1205.workers.dev
export PAN_TOKEN=pan_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

#### 3. 常用调用

```bash
# 我是谁、有哪些权限
curl -s -H "Authorization: Bearer $PAN_TOKEN" $PAN/api/me

# 总用量
curl -s -H "Authorization: Bearer $PAN_TOKEN" $PAN/api/stats

# 根目录列表
curl -s -H "Authorization: Bearer $PAN_TOKEN" $PAN/api/files

# 下载（Range 也支持）
curl -s -H "Authorization: Bearer $PAN_TOKEN" -o out.bin $PAN/api/files/<fileId>/download

# 在线播放（浏览器直接开这个 URL，带 ?token= 不行，要 Cookie 或 Bearer）
curl -s -H "Authorization: Bearer $PAN_TOKEN" -o movie.mp4 $PAN/api/files/<fileId>/play
```

#### 4. 用令牌上传（三步）

分片协议跟网页完全一样：`init` → 逐片 `PUT` → `complete`。

```bash
FILE=./big.iso
SIZE=$(stat -c%s "$FILE")          # macOS: stat -f%z
CHUNK=$((16*1024*1024))            # 16MB 一片

# ① 建会话，拿到 uploadId / chunkSize / chunksCount
INIT=$(curl -s -X POST -H "Authorization: Bearer $PAN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$(basename $FILE)\",\"size\":$SIZE,\"chunkSize\":$CHUNK}" $PAN/api/upload/init)
echo "$INIT"
UPLOAD_ID=$(echo "$INIT" | sed -E 's/.*"uploadId":"([^"]+)".*/\1/')

# ② 逐片上传（idx 从 0 开始，可以并发、可以断点续传 —— 已存在的片会跳过）
split -b $CHUNK -d -a 4 "$FILE" /tmp/part.
i=0
for p in /tmp/part.*; do
  curl -s -X PUT -H "Authorization: Bearer $PAN_TOKEN" --data-binary "@$p" \
       $PAN/api/upload/$UPLOAD_ID/chunk/$i
  i=$((i+1))
done

# ③ 收尾（校验片数与总大小，落成文件）
curl -s -X POST -H "Authorization: Bearer $PAN_TOKEN" $PAN/api/upload/$UPLOAD_ID/complete
```

要点：

- `chunkSize` 会被夹到 **5MB – 100MB**（`MIN_CHUNK`/`MAX_CHUNK`），默认 16MB。**别超 100MB**：Workers 免费版请求体上限就是 100MB。
- 每片会自动挑「剩余空间最大」的账号落盘；单片失败重传即可，已成功的片会返回 `skipped:true`。
- `complete` 会核对分片数与总字节数，对不上就报错，不会留下半截文件。

#### 5. 出错怎么看

| 状态 | 意思 |
| --- | --- |
| `401` | 没带令牌，或令牌被删/停用/写错 |
| `403` | 令牌是 `read` 范围，调了管理接口（例如 `/api/accounts`、`/api/tokens`） |
| `400` | 参数不对（缺 `name`/`size`，或分片越界） |
| `409` | 状态冲突（目录非空、前台密码没设等） |

想知道自己这条令牌能不能干某事，先打 `/api/me`，返回里的 `can` 就是答案。

### Telegram 上传渠道

给自己的 Telegram 机器人发文件，文件自动落进网盘（`src/tg.ts`）。

页面分两层，跟 WebDAV 页一个样式：

**列表页（默认）** —— 上面是「新建通道」卡，下面是通道表格。

| 列 | 含义 |
| --- | --- |
| TG 用户名 | **通道名称就是它**（必填，例如 `@dongdong_bot`），行内可「改用户名」 |
| 上传目录 | 这个通道的文件落哪个网盘目录（选「网盘根目录」就是根） |
| 白名单 | 逗号分隔的 Chat ID；**留空 = 谁都不收** |
| 状态 | 启用 / 停用（停用的通道收到的消息不落盘） |

每行有「白名单 / 停用 / 启用 / 删除」；右上角是「＋ 新建 TG 文件夹」和「⚙️ 设置」。

**设置页（点右上「⚙️ 设置」进，有「← 返回」）** —— Bot Token、Webhook、自定义 Bot API 地址、管理员 Chat ID。多白名单已经挪到每个通道自己的「白名单」里，设置页只管机器人本身。

上手顺序：

1. 找 `@BotFather` 建 bot，拿 token；「⚙️ 设置」里填进去 → 保存（会自动生成 Webhook secret）。
2. 点「注册 Webhook」，等价于调用 Telegram `setWebhook` 把 `https://<worker>/api/tg/webhook/<secret>` 挂上。
3. 回列表页「新建通道」：填 TG 用户名（就是通道名）、选上传目录、填白名单 Chat ID，点「创建」。或者点「＋ 新建 TG 文件夹」一键在建目录的同时开好通道。
4. 在 Telegram 里给 bot 发**文档 / 视频 / 音频 / 语音 / 图片**；webhook 收到后 `getFile` → 下载 → `initUpload/putChunk/completeUpload` 落盘，再回一句「✅ 已存入网盘：文件名（大小）」。
5. 落盘规则：文件落到通道的「上传目录」下，再按 **Chat ID 建一级子文件夹**（例如 `TG 上传/123456789/xxx.mp4`），不同人发的东西自然分开；子文件夹不存在会自动建。
6. 白名单是**多通道多白名单**：同一个 Chat ID 落在哪个通道，取决于哪个通道的白名单里有它（自上而下取第一个命中的启用通道）。哪个通道都不匹配就回一句「这个 Chat ID 不在任何通道的白名单里」，不落盘。不确定自己的 Chat ID？先给 bot 发一句，它会回给你。

#### 在 Telegram 里能用的命令

给 bot 发文字命令，按身份分两档（实现见 `src/tg.ts` 的 `handleTgUpdate`，命令最先处理，不受白名单限制）：

| 命令 | 谁能用 | 作用 |
| --- | --- | --- |
| /help、/start | 任何人 | 命令说明（管理员会多看到管理员那一段） |
| /id | 任何人 | 回你自己的 Chat ID（不知道填什么白名单时先发这个） |
| /usage | 任何人 | 账号池总用量 / 总容量 / 文件数 |
| /me | 白名单内 | 你在哪个通道、落到哪个目录 |
| /files | 白名单内 | 你这个 Chat ID 目录里最近的 10 个文件 |
| /stats | 管理员 | 账号数（含停用）、用量、文件数、用户数 |
| /channels | 管理员 | 所有通道：用户名 → 目录 ｜白名单人数 |
| /prune | 管理员 | 清掉 15 天前的访问日志，回删除条数 |

- 「管理员」= 设置页「管理员 Chat ID」里填的 chat id（逗号分隔，留空 = 谁都用不了管理员命令）。
- 非命令的文字消息会回一份 /help；发文件（文档/视频/音频/语音/图片）依然直接入库。
- 自检小开关：webhook 地址后加 `?debug=1`，会把这一条 update 的处理结果直接 JSON 返回（同样要 secret），方便排错。

细节与限制：
- webhook 路由是**公开**的（Telegram 来调），身份靠 URL 里的 `secret` 认；secret 不对直接 403。收到 update 后立即 200，真正的下载/落盘在 `ctx.waitUntil()` 里做，避免 Telegram 超时重投。
- 20MB 以内一片就够；超过 100MB 会自动切成多片（单片上限 `MAX_CHUNK`）。

#### 为什么 1.9GB 发得出去却收不下来

Telegram 有两条完全不同的限制，很容易搞混：

| 方向 | 云 Bot API 上限 | 说明 |
| --- | --- | --- |
| 用户 → bot（客户端发送） | 2GB（普通账号）/ 4GB（Premium） | 这是 Telegram **客户端**自己传的，bot 只拿到一个 `file_id` |
| bot → 下载（`getFile`） | **20MB** | 这才是本项目卡住的地方 |

所以：你把 1.9GB 发给 bot，Telegram 会照收，bot 也能收到那条消息和 `file_id`；但 bot 一旦调 `getFile`，云 API 直接拒绝 —— **20MB 是官方硬限制**，不是网盘设的（[getFile 文档](https://core.telegram.org/bots/api/methods/getFile.md)、[tdlib/telegram-bot-api#141](https://github.com/tdlib/telegram-bot-api/issues/141)）。

#### 想突破 20MB：接 Local Bot API Server

官方 `telegram-bot-api` 用 `--local` 跑起来之后，**下载不限大小、上传到 2000MB**（[官方说明](https://core.telegram.org/bots/api.md#using-a-local-bot-api-server)）。

1. 去 `my.telegram.org` 拿 `api_id` / `api_hash`。
2. 跑起来（它只讲 HTTP，得套 HTTPS 反代：Caddy / Nginx / Cloudflare Tunnel）：
   ```bash
   docker run -d --name tg-api -p 8081:8081 \
     -e TELEGRAM_API_ID=123456 -e TELEGRAM_API_HASH=abcdef0123456789 \
     -e TELEGRAM_LOCAL=1 tdlib/telegram-bot-api:latest
   ```
3. 后台「TG 上传」→「自定义 Bot API 地址」填 `https://tg-api.你的域名`，保存。
4. 回上面点「注册 Webhook」重挂一次（此时 webhook 是挂到本地服务器上的，可以走 HTTP / 内网 / 任意端口）。
5. 上限自动变成 2GB；要改可以在「单文件上限」里手填字节数（`0` = 自动）。

之后 `getFile` / 下载 / `setWebhook` 全部改走你填的地址，代码里只有一处 `apiBase` 在切（`tgApi(..., cfg.apiBase)`）。

---

### WebDAV 挂载（`src/dav.ts`）

把这个网盘里的**某一个目录**挂成标准 WebDAV，直接给 Windows 资源管理器、macOS Finder、nPlayer / Infuse / Documents、rclone、甚至 Emby 的媒体库连。每个挂载有自己的一条临时密钥，可以单独停用、删除、到期失效，不影响面板登录。

**在后台怎么建**（侧栏「管理 → WebDAV」）：

1. 想单独放一块就点右上「＋ 新建 WebDAV 文件夹」，它在网盘根目录建一个空文件夹。
2. 「根目录」下拉选要挂出去的目录（默认「网盘根目录」= 整个盘）。
3. 填名称、**填用户名**（默认 `dav`，随便改成 `tvbox`、`nas` 都行）、选有效期（1 天 / 7 天 / 30 天 / 永久），要防手滑就勾「只读」。
4. 点「创建并生成密钥」——**密钥只显示这一次**，下面的大绿卡里有地址、用户名、密钥，各自一个「复制」按钮。

**用户名登录后还能改**：列表里每个挂载后面有「改用户名」，改完立刻生效，密钥（密码）不变；客户端记得同步改。

**两种连接地址，任选**：

```
https://<你的域名>/dav/<挂载id>/            ← 需要 Basic 认证（用户名 = 建挂载时填的那个，默认 dav；密码 = 密钥）
https://<你的域名>/dav/<挂载id>/<密钥>/      ← 密钥写进路径，老客户端不支持 Basic 时用
```

客户端怎么填：

| 客户端 | 操作 |
|---|---|
| Windows | 此电脑 → 映射网络驱动器 → 地址填 URL，用户名/密码填上面两格 |
| macOS | Finder → 前往 → 连接服务器（⌘K）→ URL 同上 |
| Android / iOS | nPlayer / Infuse / Documents 里选「WebDAV」，填 URL + 用户名 + 密码 |
| rclone | `rclone config` → 新建 `webdav` → url 填 URL，vendor 选 `other`，user/pass 填两格 |
| Emby / Jellyfin | 添加媒体库 → 网络共享 → WebDAV，同上 |

**能做什么**：列目录、读、写、建目录、改名的全套标准方法都实现了 —— `OPTIONS / PROPFIND / GET / HEAD / PUT / MKCOL / DELETE / MOVE / COPY / LOCK / UNLOCK / PROPPATCH`。PUT 覆盖同名文件会走「删旧 + 重新落盘」，删文件沿用 blob 引用计数（同一份内容被别处引用着就不会真删）。

**上限（平台决定的，不是配置）**：

- **单次 PUT ≤ 95MB** —— Cloudflare Workers 请求体上限（Free/Pro 100MB）。超过会直接回 `413` 并提示改用分片上传。**读 / 下载 / 播放没有这个限制**（逐片流式拼接，2GB 的片也只占几十 KB 内存）。
- 更大的文件：用面板拖拽上传，或 `POST /api/upload/init` 那套分片接口（见「API 令牌 → 用令牌上传三步」）。
- 有些客户端（Windows 资源管理器）会对小文件也做 LOCK/UNLOCK，这里回的是假锁（不互斥），单用户够用；多人同时写同一文件不保证。

**管理接口**（管理员，Cookie 或 Bearer 管理令牌都行）：

```bash
# 列出所有挂载
curl -H "Authorization: Bearer $PAN_TOKEN" https://<域名>/api/dav

# 新建（folderId 传 null = 网盘根；ttlSec 传 null = 永久）
curl -X POST -H "Authorization: Bearer $PAN_TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"客厅电视","folderId":3,"ttlSec":604800,"readonly":false}' https://<域名>/api/dav
# → {"id":"...","username":"dav","key":"wd_...","expires_at":"...","url":"https://<域名>/dav/<id>/"}

# 重置密钥（旧密钥立刻失效，返回新 key）
curl -X POST -H "Authorization: Bearer $PAN_TOKEN" https://<域名>/api/dav/<id>/regen

# 停用 / 启用 / 改只读 / 改到期
curl -X PATCH -H "Authorization: Bearer $PAN_TOKEN" -H "Content-Type: application/json" \
     -d '{"enabled":false}' https://<域名>/api/dav/<id>

# 删除
curl -X DELETE -H "Authorization: Bearer $PAN_TOKEN" https://<域名>/api/dav/<id>
```

密钥在库里只存 `sha256`，明文只在创建 / 重置时返回一次；挂载停用或过期后请求一律 `403`，密钥不对是 `401`。

---

## 七、在线表格与在线文档

- **表格**（`src/sheet.ts`）：真的电子表格，不是玩具。单元格稀疏存储（一格一行），204 列上限、5000 行。
  公式求值是**手写的递归下降解析器**：支持 `+ - * /`、括号、单元格引用（`B2`、`$B$2`）、区间（`A1:C3`）以及 `SUM / AVG / AVERAGE / MIN / MAX / COUNT`。**绝不 `eval` 用户输入的字符串**。
  `saveSheet` 整片 `DELETE` 再批量 `INSERT`（按 24 条一组塞进 D1 batch），一次保存一个事务语义。还支持 TSV/CSV 粘贴导入（自动识别分隔符与双引号转义）。导出走 `/api/sheets/:id/export`，导出的是**求值后的结果**。
  编辑页里公式格默认显示**求值结果**（蓝色字），点进去才显示公式原文（像 Excel 的编辑行为）；改完任一被引用的格子，其余公式格当场重算——前端 `web/sheet-eval.js` 是同一套解析器的 JS 版（只负责显示，服务端 `sheet.ts` 才是权威口径）。
- **文档**（`src/doc.ts`）：Markdown 原文存 D1（单篇 1MB 上限），编辑页左写右预览（`Ctrl+S` 保存）；`/api/docs/:id?view=1` 输出一个渲染好的深色静态页，可以直接发给别人看；`?raw=1` 取纯文本。
  Markdown 渲染是自己写的极简实现（标题 / 列表 / 代码块 / 粗斜体 / 行内码 / 链接 / 引用 / 分隔线），不引第三方库。

---

## 八、部署步骤

### 方式一：一键部署按钮（私库也能用）

点 README 顶部的 **Deploy to Cloudflare** 按钮，会跳到 `dash.cloudflare.com` 的 Workers 创建页（`?to=/:account/workers-and-pages/create/deploy-to-workers&repository=...`），后面就是标准的「从 Git 导入」流程。

**私库可以，前提是这三条：**

1. 点按钮的是 **你自己**（有那个私库的访问权）。Cloudflare 是把仓库克隆进**你**的 GitHub 账号再构建，所以对你本人来说，私库和公库没区别。
2. **Cloudflare Workers & Pages GitHub App 已安装并授权这个私库**：GitHub → Settings → Applications → Installed GitHub Apps → `Cloudflare Workers and Pages` → Configure → 在 Repository access 里把 `CF-R2PAN` 加进去。不装/没授权就会卡在 `Cloning repository… Failed: error occurred while fetching repository`。
3. `wrangler.toml` 里两个 id 已填真实值：`database_id`、`[[kv_namespaces]] id`。一键流程会**自动创建** D1/KV（它读 wrangler 配置来 provision），但占位符会让它判断不出要建什么，直接失败。所以要么先在本机跑一遍方式二的前两步拿到 id 再提交，要么把这两个字段删掉让它自己建（建完 Cloudflare 会把真实 id 写回它克隆出来的那份配置里）。

> 官方文档写「Private repositories: Repositories must be public」——那说的是**别人**点你 README 上的按钮：他们拿不到你的私库，克隆必失败。你自己点自己的按钮不在这个限制里。这也是为什么它必须登录 `dash.cloudflare.com` 才能继续。参考 [Deploy to Cloudflare buttons 文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[GitHub 集成说明](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)。

按钮流程不跑 `schema.sql`，也不设 secrets，部署完还要手动补：

```bash
npx wrangler d1 execute pan_r2 --file=schema.sql --remote
npx wrangler secret put JWT_SECRET
npx wrangler secret put MASTER_KEY
```

> 直接复制链接：`https://deploy.workers.cloudflare.com/?url=https://github.com/ikiiing/CF-R2PAN`
>
> 如果按钮在私库上还是报 `fetching repository` 失败，走等价的手动路径：`dash.cloudflare.com` → Workers & Pages → Create application → **Connect to Git** → GitHub → 选 `CF-R2PAN`（这条本来就支持私库，选仓库列表里能看到私库就说明 App 授权没问题）。

### 方式二：本地 wrangler 部署（推荐，能一次配全）

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

#### S3 凭证的两种拿法

见文首 **「零、先拿 R2 凭证并接上账号」**（0.2 节），步骤、字段、报错对照都在那儿。


然后在「用户与密码」页设一个**前台访问密码**（可以和后台不同），把域名 + 这个密码发给朋友，他们就能只读浏览。

### 方式三：push 自动部署（GitHub Actions）

仓库里已经放好 `.github/workflows/deploy.yml`，**往 `main` 推一次就自动部署到 Cloudflare**，不用再在本机跑 wrangler。私库一样能跑。

它每次做这几步：

1. `actions/checkout` 拉代码 → Node 20 + `npm ci`
2. `npx tsc --noEmit` 类型不过就直接红，不会把坏代码推上线
3. `npx wrangler deploy` 部署（`JWT_SECRET` / `MASTER_KEY` 是 Worker 上的 secret，deploy 不会覆盖）
4. `curl /api/health` 打一次健康检查，重试 5 次，挂了这条也红

也可以在仓库 **Actions** 标签页手动点 **Run workflow** 触发，不必等 push。

#### 怎么配（一次性，做完就永久生效）

**第 1 步：加两个仓库 Secret**

仓库 → `Settings` → 左侧 `Secrets and variables` → `Actions` → `New repository secret`，加这两个：

| Secret 名 | 值 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 你的 CF API Token | 见下方「CI Token 需要哪些权限」 |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID | CF 控制台右侧/URL 里那串 32 位 hex，比如 `6e9cf67839f8b1931a7cda49315bc975` |

> 不用再传 `D1_DATABASE_ID` / `KV_NAMESPACE_ID`——`wrangler.toml` 里已经写的是真实 id。

**CI Token 需要哪些权限（不多给）**

`wrangler deploy` 只做「上传脚本 + 绑定 + 触发路由」，所以给了这几项就够，别用全权限令牌：

| 作用域 | 权限 | 为什么 |
|---|---|---|
| 账户（Account） | **Workers Scripts: Edit**（Workers Scripts Write） | 上传、发布 Worker 与静态资源，必需 |
| 账户（Account） | Account Settings: Read | wrangler 启动时要读账号设置 |
| 账户（Account） | Workers KV Storage: Edit | 绑定 KV（`wrangler.toml` 里有 KV） |
| 账户（Account） | D1: Edit | 绑定 D1（`wrangler.toml` 里有 D1） |
| 账户（Account） | **Workers R2 Storage: Edit**（Read + Write） | 网盘本体就是 R2；缺这条时 `wrangler deploy` 可能报绑定校验失败，生成 S3 凭证的页面也用不了 |
| 区域（Zone，限定到 `kids.us.ci`） | Workers Routes: Edit | 部署时同步自定义域名路由（若路由是你在控制台手加的，可省） |

> 别只给 Workers Scripts——R2 是这个项目的数据面，只给 Workers 权限时部署脚本能传上去，但一旦涉及 R2 绑定检查 / 建 R2 凭证就会 401。最小但完整的组合是上表六条。

> 完整的权限清单（含运维令牌、GitHub、Telegram、运行时绑定、反面清单）见 **[PERMISSIONS.md](./PERMISSIONS.md)**，本文只保留部署这一段。

控制台建法：`My Profile → API Tokens → Create Token → Custom token`，按上表加权限；账户资源选你的账号，Zone 资源只选 `kids.us.ci`（不要选 all zones）。

等价 API（`<CF_TOKEN>` 换成现有有权限的令牌，`<PERM_ID>` 用上面对应的权限组 id）：

```json
{
  "name": "pan-r2-ci-deploy",
  "policies": [
    { "effect": "allow",
      "resources": { "com.cloudflare.api.account.<ACCOUNT_ID>": "*" },
      "permission_groups": [
        { "id": "e086da7e2179491d91ee5f35b3ca210a" },
        { "id": "c1fde68c7bcc44588cbb6ddbc16d6480" },
        { "id": "09b2857d1c31407795e75e3fed8617a1" },
        { "id": "f7f0eda5697f475c90846e879bab8666" },
        { "id": "b4992e1108244f5d8bfbd5744320c2e1" },
        { "id": "bf7481a1826f439697cb59a20b22293e" }
      ] },
    { "effect": "allow",
      "resources": { "com.cloudflare.api.account.zone.<ZONE_ID>": "*" },
      "permission_groups": [ { "id": "28f4b596e7d643029c524985477ae49a" } ] }
  ]
}
```

> 账号级令牌里放 zone 权限时，`resources` 的键必须写成 `com.cloudflare.api.account.zone.<ZONE_ID>`（写成 `com.cloudflare.api.account.zone.*` 会报 `Must specify a zone for account owned tokens`）。

> 该令牌创建后**只在创建响应里出现一次明文**，记得立刻存进仓库 Secret。用 `Authorization: Bearer <token>` 调 `GET /accounts/<acc>/workers/scripts/pan-r2` 返回 200 就说明权限对了。

**第 2 步：确认这个 GitHub 账号的 Actions 是开着的**

GitHub 有个**账号级**开关，关掉时所有仓库的 workflow 都不触发，API 会直接回：

```
{"message":"Actions has been disabled for this user.","status":"422"}
```

到 `github.com/settings` → 侧栏 **Actions → General**，确认允许 Actions（组织/企业账号还要看组织策略有没有禁）。没开时仓库 `Actions` 标签页会显示 "Workflows aren't being run on this repository"。

> 实测记录：`ikiiing` 这个账号当前 Actions 被平台禁用（`GET /repos/.../actions/permissions/access` 返回 `access_level: "none"`，手动 dispatch 也回 422）。所以这套 workflow 现在**推上去不会触发**，得先在 GitHub 账号设置里把 Actions 打开；打开后 push 一次就会自动跑。

**第 3 步：验证**

推一次任意提交（或手动 Run workflow），进仓库 **Actions** 标签页看 `Deploy to Cloudflare Workers` 这条：绿勾 = 已上线；红叉点进去看是哪一步挂的（typecheck / deploy / smoke test 都有独立日志）。

#### 用 Cloudflare 原生的 Workers Builds（不依赖 GitHub Actions）

如果 GitHub Actions 那条路走不通（比如账号被禁），换 Cloudflare 自己的 Git 集成，效果一样——push 就自动部署：

1. `dash.cloudflare.com` → Workers & Pages → 点 `pan-r2` → **Settings → Builds → Connect**。
2. 选 GitHub → 授权 `Cloudflare Workers and Pages` App（私库要在 App 的 Repository access 里勾上 `CF-R2PAN`）→ 选仓库、分支 `main`。
3. 构建命令留空（本项目无构建步骤，前端是单文件），部署命令填 `npx wrangler deploy`。
4. 保存后 push 到 `main` 由 Cloudflare 自动构建部署，日志在 Worker 的 **Deployments / Builds** 里看。

区别：GitHub Actions 用你仓库自己的 Secrets、在 GitHub 跑；Workers Builds 在 Cloudflare 侧跑、绑定沿用现有 Worker，连 id 都不用填，但要在控制台点一次授权。

#### 常见坑

- `npm ci` 报 `Missing: ... from lock file`：本地 `package-lock.json` 和 `package.json` 不同步，先本地 `npm install` 提交 lock 文件再推。
- `wrangler deploy` 报 `Authentication error / code 10000`：`CLOUDFLARE_API_TOKEN` 权限不够或过期，重建一个含 `Workers Scripts: Edit` 的 token。
- 部署成功但打不开：先手动 `curl https://<你的域名>/api/health`，再检查 `wrangler.toml` 里的 D1/KV id 是不是对应当前账号。


### 自定义域名 / 路由

把 Worker 挂到自己域名上，有两种常见形态：

**A. 域名就在本账号下（最简单）**：`Workers & Pages → pan-r2 → Settings → Domains & Routes → Add → Custom Domain`，填 `pan.example.com`，Cloudflare 会自动加 DNS 记录并签发证书。

**B. 走 SaaS 回源（本仓库线上用的就是这种）**：`pan.kids.us.ci` 这个域名如果不在 Worker 所在账号，就用「CNAME 指向一个 SaaS 回源地址 + Worker 路由」的组合：

1. **Worker 路由**：`Workers & Pages → pan-r2 → Settings → Triggers → Routes → Add route`，填 `pan.kids.us.ci/*`，选 `pan-r2`。等价 API：
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/workers/routes" \
     -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
     -d '{"pattern":"pan.kids.us.ci/*","script":"pan-r2"}'
   ```
2. **DNS 加一条 CNAME**（在 `kids.us.ci` 的 DNS 管理里）：`pan` → `saas.sin.fan`，**代理状态关掉（灰色小云 / DNS only，`proxied=false`）**，TTL 自动。
3. 等一两分钟 DNS 生效，`curl https://pan.kids.us.ci/api/health` 应回 `{"ok":true,...}`。

> 灰云（DNS only）也能用，是因为 `saas.sin.fan` 本身就是 Cloudflare for SaaS 的回源入口，请求最终仍回到 CF 边缘，再由上面的 Worker 路由接管。所以这条 CNAME 必须是灰云、不能开黄云，否则会和 SaaS 回源打架。

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

## 十、文件管理功能

除了「传上去 / 下下来」，这一层把日常用得着的都做了。全部只依赖现有的 D1 / KV / R2，没有额外服务。

### 回收站

删除先是软删（`files.deleted_at` / `folders.deleted_at` 打时间戳），文件与分片都还在，配额也没退。**目录删除也走软删**（整棵子树一起进回收站，能还原）。回收站页可以单条还原或彻底删除；`POST /api/trash/purge {all:true}` 一次清空。统计、目录树、WebDAV 列表都只看 `deleted_at IS NULL` 的部分。**配额只在真删时退还**（`deleteFileDeep` 走 `blobs.refs` 引用计数，最后一份引用消失才 `s3Delete` 并 `reserveBytes(-size)`）。

### 缩略图与相册

- 上传图片时前端用 canvas 缩到长边 480px、JPEG q0.72，`PUT /api/files/:id/thumb` 存进 KV（key `thumb:<id>`，上限 200KB，content-type 存在 KV metadata 里），`GET` 直接吐字节。
- `/api/photos` 列出全部图片并标出哪些已有缩略图；相册页走瀑布流卡片，没缩略图的显示占位，点「补齐缩略图」会逐个从 `/api/files/:id/preview` 拉前 256MB 生成。
- 缩略图是**明文派生数据**：加密目录里的图片不做缩略图（否则等于把内容漏出来）。

### 全文搜索 / 标签 / 收藏 / 最近

- `/api/search?q=` 同时搜文件名、目录名、文档名与正文（`LIKE %q%`），文件/目录/文档/表格各取 50 条。
- 标签是全局的（`tags` 表），多对多挂 `file_tags`；可批量打。
- 收藏按用户记（`stars`），最近访问按用户记（`recent`，只在 `download`/`play` 时写，避免列表页刷爆）。API 令牌访问不记「最近」。

### 批量操作

文件行前面的勾选框 → 底部浮动条：删除 / 移动到当前目录 / 打标签 / 打包下载。后端 `POST /api/batch {op:'delete'|'move'|'tag', ids}`；`/api/move`、`/api/copy` 各自带目录自嵌套检测。

### 在线解压（`POST /api/files/:id/unzip`）

服务器端读 zip 的中央目录，把每个条目取出来写进网盘：**store 与 deflate 两种压缩都支持**（deflate 走 Workers 的 `DecompressionStream('deflate-raw')`），目录结构原样建出来，`__MACOSX/`、`.DS_Store`、`._` 开头的条目自动跳过。上限 64MB 整包（内存与子请求决定），rar/7z 不支持。文件行上 `.zip` 会有「解压」按钮。

### 打包下载（`GET /api/zip?ids=`）

服务端手写 store（不压缩）zip：local header + central directory + EOCD，逐片从 R2 拉出来直接写进流，不在内存里攒整包。**上限 64MB 总量 / 50 个文件**——这是 Worker 内存与子请求数决定的，再大请用客户端逐个下。

### Web 端剪切 / 粘贴

右键菜单「剪切 / 复制」把选中项存进 `sessionStorage`，进目标目录后 `Ctrl+V` 或右键「粘贴到这里」执行 move/copy。

### 分享：有效期 / 次数 / 提取码 / 每日限额

分享短码本身是凭证，配置全在 KV 里（`share:<短码>` → `ShareRecord`）：

| 字段 | 作用 |
|---|---|
| `exp` | 到期时间，KV 的 `expirationTtl` 同步 |
| `max` / `used` | 总下载次数上限与已用 |
| `code` | 提取码；有值时首屏先给提取码页，`?code=` 对上才出下载页 |
| `dayMax` / `dayUsed` | 每天最多下载几次（跨天自动清零，`dayKey` 记日期） |
| `byteMax` / `dayBytes` | 每天最多下多少字节（按文件大小预扣） |

超限分别返回 429「今天的下载次数用完了」/「今天的流量用完了」。**只有整份下载（无 `Range` 头）才计一次**，视频拖进度条、断点续拉不重复扣次数。撤销 = `DELETE /api/shares/:jti` 删 KV 键，链接立刻 404。老的长签名链接（`base64url.签名`）仍然兼容。

### 上传队列 / 断点续传

- 每个文件开始上传时把 `{uploadId, name, size, chunkSize, chunksCount, done:[]}` 记进 `localStorage`，每传完一片回写 `done`。
- 中断（关页面、断网、失败）后回到上传页会看到「有 N 个没传完」，点「继续」选同一个文件（名字与大小要一致）→ 只用原来的 `uploadId` 重传缺的片，已传的片在服务端也会被 `putChunk` 幂等跳过。
- 幂等靠的是 `chunks UNIQUE(file_id, idx)` + 先查后写；配合内容寻址去重，重传同内容的分片直接命中 `blobs`。

### 客户端加密文件夹（零知识）

目录可以设口令：`PUT /api/folders/:id/enc {salt}` 只把**盐**存服务器（`folders.enc_salt`），口令永远不出浏览器。

- 上传：`PBKDF2-SHA256(口令, 盐, 150000 次)` → AES-GCM-256 密钥；每片单独加密，IV = `SHA-256(盐 + ':' + 分片序号)` 前 12 字节（确定性，服务端无法重排）。密文大小 = 明文 + 16 字节认证标签，所以 `init` 时报 `size + 16 * chunks`，`enc_meta` 存 `{salt, v:1, chunks}`。
- 下载：文件行显示 🔒，按钮变「解密下载」——整份拉下来按片解密，再另存到本地。
- 服务端拿到的是密文分片，去重与配额都按密文算；口令丢了文件就打不开，这是设计使然。**加密目录不做缩略图；加密文件不能分享、不能在线解压、不能打包下载、没有预览**（这些出口给出去的都是密文，解不开），只有浏览器里输口令「解密下载」。

> 注意：这是「网盘看不到内容」级别的加密，不是抗审查：盐与文件大小、分片数仍然可见。

### 还没做的（有意留白）

`Durable Object` 做原子配额（当前靠 `reserveBytes` 的 `MAX(0, ...)` 兜底，并发抢同一账号可能少算）、跨账号冗余副本（`chunks.replica_of`）、冷热分层（小文件留前几个账号）。

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
| GET | `/api/files/:id/preview` | 试播前缀流：只返回前 256MB（大文件/编码受限时的兜底） |
| GET | `/api/sheets` · `/api/sheets/:id` · `/:id/export` | 表格列表 / 内容 / 导出 TSV |
| GET | `/api/docs` · `/api/docs/:id` | 文档列表 / 内容（`?raw=1` 纯文本，`?view=1` 渲染页） |
| GET | `/api/search?q=` | 全文搜索（文件/目录/文档/表格） |
| GET | `/api/photos` | 图片列表 + 是否有缩略图 |
| GET | `/api/files/:id/thumb` | 读缩略图（KV） |
| GET | `/api/trash` | 回收站 |
| GET | `/api/tags` · `/api/files/:id/tags` | 标签列表 / 某文件的标签 |
| GET | `/api/stars` · `/api/recent` | 收藏列表 / 最近访问 |
| GET | `/api/zip?ids=` | 打包下载（store zip，≤64MB / 50 文件） |

写（仅 admin）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST/PATCH/DELETE | `/api/folders[/:id]` | 新建 / 改名 / 删除（**递归移入回收站**：子目录与文件一起标记 `deleted_at`，可还原；返回 `{folders,files,trashed:true}`） |
| POST | `/api/upload/init` | 开上传会话 |
| PUT | `/api/upload/:id/chunk/:idx` | 传一片 |
| POST | `/api/upload/:id/complete` | 收尾成文件 |
| DELETE | `/api/files/:id` | 软删（进回收站；`?hard=1` 才真删并退配额） |
| PATCH | `/api/files/:id` | 重命名 `{name}` |
| POST | `/api/files/:id/share` | 生成分享短码（`ttlSec` / `maxDownloads` / `code` / `dailyMax` / `dailyBytes`） |
| GET/PATCH/DELETE | `/api/shares[/:jti]` | 分享列表 / 改提取码与配额 / 撤销 |
| POST | `/api/trash/restore` · `/api/trash/purge` | 还原 / 彻底删除（`{all:true}` 清空） |
| POST | `/api/batch` | 批量操作 `{op, ids}`（op = delete / move / tag） |
| POST | `/api/move` · `/api/copy` | 移动 / 复制（`{kind,id,folderId}`，带自嵌套检测） |
| POST/DELETE | `/api/files/:id/star` | 收藏 / 取消 |
| POST/DELETE | `/api/tags[/:id]` | 新建 / 删除标签 |
| POST | `/api/files/:id/tags` | 给文件打标签 `{tagId}` |
| PUT/GET | `/api/files/:id/thumb` | 上传 / 读取缩略图（≤200KB） |
| PUT | `/api/folders/:id/enc` | 开/关目录加密（只存盐 `{salt}`，`{salt:null}` 关闭） |
| GET/POST/PATCH/DELETE | `/api/accounts[/:id]` | 账号池 CRUD |
| POST | `/api/accounts/:id/test` | 测桶连通（`s3HeadBucket`） |
| GET/POST/PATCH/DELETE | `/api/users[/:id]` | 用户（不许降级/删除最后一个 admin） |
| POST | `/api/front/password` | 设前台访问密码 |
| POST | `/api/password` | 改自己的密码 |
| GET | `/api/visits?limit&offset&summary=1` | 访问日志 |
| POST | `/api/visits/prune` | 立即清理 `{days}` |
| GET | `/api/locks?u=&ip=` | 查某账号/IP 是否被锁 |
| GET/POST | `/api/tokens` | API 令牌列表 / 新建（返回一次性明文） |
| PATCH/DELETE | `/api/tokens/:id` | 启停 / 删除令牌 |
| GET/POST | `/api/tg/channels` | TG 通道列表 / 新建通道（`name` `folderId` `botUsername` `allowedRaw`） |
| PATCH/DELETE | `/api/tg/channels/:id` | 改名称/目录/白名单/启停、删除通道 |
| GET/POST | `/api/tg/config` | TG 机器人配置（`regenSecret` / `clearToken`） |
| GET | `/api/tg/info` | `getWebhookInfo` + 机器人用户名 |
| POST | `/api/tg/register` \| `/api/tg/unregister` | 挂 / 摘 Webhook |
| POST | `/api/tg/webhook/:secret` | **公开**，Telegram 回调入口 |
| GET/POST | `/api/dav` | WebDAV 挂载列表 / 新建（返回一次性密钥） |
| PATCH/DELETE | `/api/dav/:id` | 启停 / 改只读 / 改到期 / 删除挂载 |
| POST | `/api/dav/:id/regen` | 重置挂载密钥（返回新 key） |

WebDAV 网关本身（不用 Cookie，走 Basic 或路径里的密钥）：

| 方法 | 路径 | 说明 |
|---|---|---|
| ALL | `/dav/:mountId/*` | 标准 WebDAV：`OPTIONS / PROPFIND / GET / HEAD / PUT / MKCOL / DELETE / MOVE / COPY / LOCK / UNLOCK / PROPPATCH` |
