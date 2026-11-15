# 权限速查（Cloudflare / GitHub / Telegram 各要什么）

一把梭的版本：本项目只需要 **4 类凭据**，全部都是最小权限，不需要任何「全能 / All permissions」令牌。

| # | 凭据 | 用在哪 | 存哪 | 权限最小集 |
|---|---|---|---|---|
| 1 | R2 S3 凭证（AK/SK） | Worker 运行时读写桶 | D1 `accounts` 表（`MASTER_KEY` 加密） | 该桶的 **Object Read & Write** |
| 2 | Cloudflare API Token（部署） | `wrangler deploy` / GitHub Actions | 本机环境变量 / GitHub Secret | 《二》6 条 |
| 3 | Cloudflare API Token（运维，可选） | 建 D1/KV、改 DNS、管 R2 桶 | 本机 `.env`，不进仓库 | 《三》3–4 条 |
| 4 | Telegram Bot Token | TG 上传渠道 | D1 `settings` 表 | 不给权限组，BotFather 发给你 |

> 判定标准很简单：**能不用全能令牌就不用**。跑起来需要的每一组权限都在下面列全了，照抄即可。

---

## 一、R2 S3 凭证（运行时，必需）

Worker 往 R2 写分片、读分片、删分片，全靠这一对。

| 项 | 值 |
|---|---|
| 在哪建 | Cloudflare 控制台 → R2 → **Manage R2 API Tokens** → Create API token |
| Permissions | **Object Read & Write** |
| Bucket 范围 | **只勾你那一个桶**（例：`pan`），千万别选 All buckets |
| TTL | 永久（或按你口味设） |
| 产出 | `Access Key ID`（32 位 hex）、`Secret Access Key`（64 位 hex，**只显示一次**） |

用到的 R2 操作：`PutObject`、`GetObject`（含 Range）、`DeleteObject`、`HeadBucket`。
所以只需要对象读写 + 列桶权限，**不需要**「R2 Admin / 桶管理 / 数据分析」那些。

⚠️ Cloudflare 的 `GET/POST /accounts/<acc>/r2/api_tokens` 对账号级令牌一律返回
`404 {"code":10015,"message":"No route matches this url."}` —— 这条路不开放，只能在控制台点。

> 复刻方式（可选）：`Access Key ID = 令牌 ID`，`Secret Access Key = sha256(令牌明文)`。
> 要求那条令牌带 `Workers R2 Storage Read` + `Workers R2 Storage Write`。见《二》。

---

## 二、部署用 Cloudflare API Token（`wrangler deploy` / GitHub Actions）

这是唯一会被 CI 使用、也可能出现在日志里的凭据，所以按最小权限给。

| 作用域 | 权限 | 为什么需要 |
|---|---|---|
| Account | **Workers Scripts: Edit** | 上传脚本、静态资源，发布版本 |
| Account | **Workers R2 Storage: Edit**（= Read + Write） | 项目的数据面；缺它时涉及 R2 的绑定校验/凭证页会 401 |
| Account | **Workers KV Storage: Edit** | `wrangler.toml` 里有 KV 绑定 |
| Account | **D1: Edit** | `wrangler.toml` 里有 D1 绑定 |
| Account | **Account Settings: Read** | wrangler 启动时读账号设置 |
| Zone（只选 `kids.us.ci`） | **Workers Routes: Edit** | 部署时同步 `pan.kids.us.ci/*` 路由（路由若手动加过，可省） |

**不需要**：Zone→DNS、Zone→Zone Settings、Account→Workers Builds、Account→Members、User→*。

### 控制台建法

`My Profile → API Tokens → Create Token → Custom token`：

- Permissions 按上表加五行 Account 权限（R2 那条要勾 Read 和 Write 两个）
- Account Resources：选你的账号
- Zone Resources：**Include → Specific zone → `kids.us.ci`**（勿选 All zones）

### API 建法（脚本化）

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/tokens" \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "pan-r2-ci-deploy",
    "policies": [
      { "effect": "allow",
        "resources": { "com.cloudflare.api.account.'"$ACC"'": "*" },
        "permission_groups": [
          { "id": "e086da7e2179491d91ee5f35b3ca210a" },
          { "id": "b4992e1108244f5d8bfbd5744320c2e1" },
          { "id": "bf7481a1826f439697cb59a20b22293e" },
          { "id": "f7f0eda5697f475c90846e879bab8666" },
          { "id": "09b2857d1c31407795e75e3fed8617a1" },
          { "id": "c1fde68c7bcc44588cbb6ddbc16d6480" }
        ] },
      { "effect": "allow",
        "resources": { "com.cloudflare.api.account.zone.'"$ZONE"'": "*" },
        "permission_groups": [ { "id": "28f4b596e7d643029c524985477ae49a" } ] }
    ]
  }'
```

权限组 id 对照（2026-11 实测）：

| id | 名称 |
|---|---|
| `e086da7e2179491d91ee5f35b3ca210a` | Workers Scripts Write |
| `b4992e1108244f5d8bfbd5744320c2e1` | Workers R2 Storage Read |
| `bf7481a1826f439697cb59a20b22293e` | Workers R2 Storage Write |
| `f7f0eda5697f475c90846e879bab8666` | Workers KV Storage Write |
| `09b2857d1c31407795e75e3fed8617a1` | D1 Write |
| `c1fde68c7bcc44588cbb6ddbc16d6480` | Account Settings Read |
| `28f4b596e7d643029c524985477ae49a` | Workers Routes Write |

⚠️ 坑：账号级令牌里放 zone 权限，`resources` 的键必须写 `com.cloudflare.api.account.zone.<ZONE_ID>`。
写成 `com.cloudflare.api.account.zone.*` 会回 `1001 Must specify a zone for account owned tokens, or nest zone under specific account resource`。

### 验证这把令牌够不够

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/pan-r2 \
  -H "Authorization: Bearer $CI_TOKEN"          # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' https://api.cloudflare.com/client/v4/accounts/$ACC/r2/buckets \
  -H "Authorization: Bearer $CI_TOKEN"          # 期望 200
```

两个都 200 就能跑 CI。出现 `401 Authentication error [code: 10000]` 就是缺权限组。

---

## 三、运维用 Cloudflare API Token（可选，但省事）

做这些事需要账号级写权限（本地脚本、不是 Worker 运行时）：

| 动作 | 需要的权限 |
|---|---|
| 建 D1 库 / 跑 `schema.sql`（`scripts/d1-apply.mjs`） | Account → **D1: Edit** |
| 建 KV 命名空间 | Account → **Workers KV Storage: Edit** |
| 加/删 DNS 记录（挂自定义域名） | Zone → **DNS: Edit** |
| 建 Worker 路由 | Zone → **Workers Routes: Edit** |
| 管理 R2 桶 | Account → **Workers R2 Storage: Edit** |
| 建/撤 API 令牌 | Account → **Account Settings: Edit** |

一个令牌塞进上面 5 条（DNS 那条选具体 zone）就够了。这就是「全能」的正确替代。

---

## 四、GitHub Actions 需要的 GitHub 侧权限

| 项 | 需要什么 |
|---|---|
| 仓库 Secret | 只需 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`（另外两个 D1/KV id 可选，`wrangler.toml` 已写死） |
| 仓库自身 | Actions 打开（`Settings → Actions → General`） |
| 你的 GitHub 账号 | **Actions 功能没被平台禁用**，见下 |
| GitHub PAT（只有用 API 改仓库时才要） | `repo` + `workflow`（提交 workflow 文件必须带 `workflow` scope） |

workflow 里脚本用的是仓库自动注入的 `GITHUB_TOKEN`，**不需要你自己造 PAT**。

账号级被禁时的报错原文（2026-11 本仓库实测）：

```
POST /repos/<owner>/<repo>/actions/workflows/<id>/dispatches
422 {"message":"Actions has been disabled for this user."}
```

`GET /repos/<owner>/<repo>/actions/permissions/access` 会返回 `{"access_level":"none"}`。
开关位置：`github.com/settings` → 侧栏 **Actions → General** → Allow；企业/组织账号还要看组织策略。

---

## 五、Telegram Bot Token

| 项 | 说明 |
|---|---|
| 建 | `@BotFather` → `/newbot` → 拿到 `123456:AA...` |
| 权限 | 不给权限组，token 本身就是全部；把 bot 拉进目标 chat / 频道，给它发消息权限 |
| 存 | D1 `settings`（key `tg_bot_token`），面板里填，不落仓库 |
| Webhook | `https://<你的域名>/api/tg/webhook/<secret>`，secret 在面板「重新生成」 |
| 大文件 | 云 Bot API 的 `getFile` 硬上限 **20MB**；要拉 20MB 以上必须自建 Local Bot API Server（见主 README「Telegram 上传渠道」） |

---

## 六、Worker 运行时所需要的 Secret / 绑定一览

| 名称 | 类型 | 必需 | 作用 |
|---|---|---|---|
| `DB` | D1 binding | ✅ | 全部元数据 |
| `KV` | KV binding | ✅ | 分享令牌、登录限流计数 |
| `ASSETS` | assets binding | ✅ | 前端静态文件 |
| `JWT_SECRET` | secret | ✅ | 登录 Cookie 签名 |
| `MASTER_KEY` | secret | 建议 | 加密 `accounts.secret_access_key`（不配则 `plain:base64`） |
| `PUBLIC_SECRET` | secret | 可选 | 前台访客 Cookie 单独签名，不配则复用 `JWT_SECRET` |
| `BOOTSTRAP_ADMIN` | var | 首次 | `admin:密码`，建好管理员后清空 |
| `PUBLIC_APP_NAME` | var | 可选 | 页面标题 |
| `LOG_VISITS` | var | 可选 | `0` 关闭访问日志 |
| `VISIT_KEEP_DAYS` | var | 可选 | 日志保留天数，默认 15 |

> **WebDAV / API 令牌 / 分享链接 / 在线表格文档都不需要额外的 Cloudflare 权限**：它们全在 Worker 里跑，数据落同一个 D1 + KV + R2。WebDAV 的「临时密钥」是本项目自己发的一条随机串（库里只存 `sha256`），跟 CF 的 API Token 完全无关，不用去控制台建任何东西，后台点一下就有。

---

## 七、反面清单（这些权限本项目用不到）

- Account → **Workers Builds / Workers CI**：用 GitHub Actions 时不需要
- Account → **Members / Account Settings: Edit**：除非你要脚本化建令牌
- Zone → **Zone Settings / SSL / Cache / Page Rules**：一个都不需要
- User → **All**：wrangler 用账号级令牌即可，不需要 user 级
- R2 → **All buckets**：永远只勾具体桶

---

## 八、撤令牌之前该确认的三件事

1. `grep -rn "cfat_\|ghp_" .` 确认仓库里没有明文令牌（本项目代码不含任何令牌）。
2. 本机环境变量里那些临时用的（`$env:CLOUDFLARE_API_TOKEN`）已经清掉或换成新令牌。
3. 新令牌验证过：`wrangler deploy` 能成功、`/api/health` 返回 200、GitHub Secret 已更新。
