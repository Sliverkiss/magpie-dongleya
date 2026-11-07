# magpie-dongleya 开发跟踪（agent md）

> 目标：把懂了鸭（dongleya.qq.com，腾讯「AI 趣味学习社区」）包成 magpie **供应商插件**——登录它的账号，让它的模型能被 agent 用。
> 站点：https://dongleya.qq.com/chat（前端 `https://dongleya.gtimg.com/prod/`，Vite 构建，React + zustand）
> 本文档是唯一进度真相；每完成一步回写。谁改了什么、卡在哪，全记这里。

## 状态机

- [x] S0 页面侦察（入口 bundle 拉下来了）
- [x] S1 前端逆向：端点清单 + 对话协议 + 认证方式
- [x] S1.5 官方 Skill 包拆包 + 在线探针实测（auth 面，见「认证路线定论」）
- [x] S2 GitHub 查已有逆向实现（gh cli）— **零命中，无现成实现**
- [ ] S3 读 magpie 插件规范（skill magpie-plugin-refactor，references 在本地）— 子代理进行中
- [ ] S4 参考现有插件（mimo2api 的结构）— 子代理进行中
- [ ] S5 插件骨架（package.json / index.mjs / src/）
- [ ] S6 auth（登录方式 + loader）
- [ ] S7 对话代理（chat → 上游协议转译）
- [ ] S8 usage / checkin（credits 接口）
- [ ] S9 测试 + 打分（bun test，check.mjs / score.mjs）
- [ ] S10 交给 YG 登录实测

---

## 认证路线定论（S1.5，2026-11-07 实测探针）

官方 Skill 包（`reverse-bundles/official-skill/`，v2.2.1）+ 在线探针把认证面钉死了：

| API 面 | 凭据 | 实测 |
|---|---|---|
| `/api/mcp/agent/content-assets`（MCP，JSON-RPC 2.0 over POST） | `X-Agent-Token` 头 | 无效 token 时 `tools/list`/`initialize` **仍返回 200**；`tools/call` 才 401 `{code:-32001, data:{code:"INVALID_TOKEN", appCode:20001}}`。工具全表 21 个（作品上传/草稿/发布投稿/合集），全部是**内容资产**面，不覆盖对话 |
| `/api/v3/chat` | 浏览器 JWT Bearer | `curl` 裸打：403 `Invalid client`（appCode 20003）；**带浏览器 UA 即 401** `Authentication required` → UA 是硬校验，token 是唯一凭据。`X-Agent-Token`/`Bearer <agent-token>` 都不吃 |
| `/api/auth/me`、`/api/credits` | JWT Bearer | 同上 401；credits 明确提示 `Include Authorization: Bearer <token>` |
| `/api/models` | **公开** | 无需登录，返回全量模型 + costMultiplier + reasoningEfforts（实测 10 个模型：auto/deepseek-v4.1-flash/hy4/hy3/minimax/kimi-k3.1-pro/glm-5.3-flashx…） |

**定论：S6 auth 走「用户从浏览器抠 JWT → 插件存 Bearer token」**。Agent Token（`dlya_at_*`）只对 MCP 内容资产面有效，**不能用来发对话**——网页端 token 管理接口（`/api/agent-tokens` CRUD + `/secret` 展示、`/renew`、`/revoke`，`reverse-bundles/dly-tokens.js`）证实这是另一套体系。

### 为什么不用标准 OAuth 弹浏览器（已论证，别再走回头路）

懂了鸭 pc 微信登录 = 微信开放平台 `WxLogin` iframe 扫码，回调链是：

```
GET /api/auth/login-url (credentials:include) → {state}
  → open.weixin.qq.com/connect/qrconnect?appid=wxc7e36f816ae387de
      &redirect_uri=<origin>/api/auth/wechat-redirect?redirect_uri=<原回调>&state=...&scope=snsapi_login
  → 微信 302 回 dongleya.qq.com/api/auth/wechat-redirect?code=...&state=...
  → 服务端消费 code、种会话，浏览器落到前端
```

`redirect_uri` 被微信后台白名单**锁死在 dongleya.qq.com**，magpie 的 loopback（`method:"auto"`）拿不到 code；code 一次性、由用户浏览器那边消费。**标准 OAuth A 型此路不通。**
headless 浏览器（C 型）能绕，但要拖 Chromium 依赖 + 扛扫码轮询，插件包体积不值。

### 采用方案：SMS 验证码登录（richee2api 同款）+ 粘贴 JWT 兜底

实测接口（`dly-index.js` @smsAuth，`_i` / `Mh` / `Ni`）：

```
POST /api/auth/sms/send-code    {"phone":"1xxxxxxxxxx"}     // purpose 省略 = login
POST /api/auth/sms/verify-code  {"phone":"...","code":"..."}
  → { success:true, token:"<JWT>", user:{...}, isNewUser:boolean }
```

`Ni(token, user)` 把 `token` 写 `localStorage["eureka_token"]`、`user` 写 `eureka_user`——插件拿 `token` 即拿到整套凭据。

- 登录方式 ①：`type:"oauth"` + `prompts:[{key:"phone"}]` + `method:"code"`，`authorize` 发码、`callback` 换 token（**照抄 richee2api/index.mjs:187 的形状**）。
- 登录方式 ②（兜底）：`type:"api"`，让用户贴 `eureka_token`（devtools 或 Console 一行 `copy(localStorage.eureka_token)`）。
- 无 refresh token 体系 → `refresh` 只探活 `/api/auth/me`，JWT `exp` 到期就 `signIn:"expired"` 让用户重登。
- 风险待实测：发码是否触发腾讯图形验证码（前端 `_i` 没带任何 captcha 参数，估算无）；单手机号每日发码次数。
- `Authorization: Bearer <agent-token>` 打 credits 返回 `INVALID_TOKEN`（不是 20000 未登录）→ **Bearer 通道确实存在但只认会话 JWT**。
- 403 `Invalid client` 的成因 = 缺浏览器 UA（已隔离验证）；`X-Request-ID` 非必需。
- CORS `access-control-allow-headers: Content-Type,Authorization,X-Request-ID,X-Requested-With,traceparent,tracestate`（**没有** X-Agent-Token，它是 MCP 面专用）。
- MCP 面对插件是免费加项：同一 JWT 页面能建 Agent Token 的话，之后可以做「作品发布」页。**不做进 S6**，砍掉，避免面铺太宽。

另：`/api/auth/config` 公开（sms enabled、wechatPc appId `wxc7e36f816ae387de`、`passwordAuthEnabled:false`——**密码登录线上是关的**，mimo2api 式账密登录这条路不存在）。SMS 验证码登录在插件里不可行（收不到短信）→ **唯一可行入口就是用户从浏览器 localStorage 抠 `eureka_token`**。

---

早期结论「推断 cookie 会话」**错误**，现按实际代码推翻（此为 S1 阶段结论，后续 S1.5 进一步定论见上）：

- 所有 API 走 `Authorization: Bearer <token>`，token 存 `localStorage["eureka_token"]`（JWT，`atob(payload)` 可解出 `userId|sub|id`、`exp`）。
- `fetch` 未显式传 `credentials` → 浏览器默认 `same-origin`；`credentials:"include"` 只在少数微信绑定/交换接口出现。
- `document.cookie` 全库只有两处：一个 js-cookie 风格的通用库（语言偏好），和 `cD()` 登出时清空 **所有** cookie。
- 结论：**插件 auth loader 抓的是 Bearer token，不是 cookie jar**。会话探活走 `GET /api/auth/me`。

---

## 已逆向事实（全部有出处，bundle 在 reverse-bundles/）

### 0. 统一 fetch 包装器 `authFetch`（`dly-ttb.js` @1175562，符号 `le`）

`le` 在 `dly-index.js` 里别名 `he`、`dly-chat.js` 里别名 `cr`——**同一个函数**（导出表 `le as X`，两处 `import{X as he}` / `{X as cr}`）。签名 `le(url, {silent?, ...init})`。

执行顺序：
1. `gp()` 取 token（localStorage `eureka_token`；firebase 模式下先 `getIdToken()` 并回写；quota 超限时回落缓存）。
2. `Pe()` 取 user（localStorage `eureka_user`）。
3. `i = !!(token || user)`。
4. 无 `Authorization` 时注入 `Authorization: Bearer ${token}`。
5. 仅当 `token === "dev-token"` 时注入 `X-Eureka-Follow-Demo-Account`（`sD()` 恒返回 `null`，死代码）。
6. `fp(url)` 处理 base URL 前缀（`hp()` 读 `__USE_ORIGIN__`，默认空 → 同源相对路径）。
7. `fetch(url, {...init, headers})`。

**状态码判定（逐条对照过）：**

| 状态 | 行为 |
|---|---|
| `401` | **直接 throw `AuthExpiredError`**。不解析 body、不看 `codeName`、不做任何 code 匹配。`silent:false && i && user` 时额外调 `bp("expired")` 触发全局登出跳转——但异常照抛。 |
| `429` | `Retry-After` header → `Number()` → `retryAfterSec`（非有限数则 `undefined`）。`clone().json()` 取 `codeName ?? error.code` 作 `code`，`error.details ?? details` 作 `details`。throw `RateLimitedError`。 |
| `ok` + JSON body 且 `code!==0` 或 `success===false` | `c2()` 检出 → `kD()` 包成 **HTTP 400** 的 `Response`（body 原样透传）。这是业务错误，**不是 401**。 |
| `409` + body `codeName==="ACCOUNT_LINK_REVIEW_REQUIRED"` | `CD()` 改写 body 塞中文 message 后原样返回，不抛。 |
| 其他 | 原样返回 `Response`。 |

错误类：
```js
class AuthExpiredError extends Error { name = "AuthExpiredError" }   // 无额外字段
class RateLimitedError extends Error { retryAfterSec; details; code; name = "RateLimitedError" }
```

**各家差异总结**：唯一的「失效」信号就是 401，无 body 约定。插件要区分「token 过期」和「账号被封/邀请制」只能靠 `GET /api/auth/me` 的 `success:false` + `codeName`。**不会**出现 403 表示未登录。

**全局 fetch/XHR 劫持**（`dly-index.js` @306293，`np()`）——对所有同源 `/api*` 请求强制注入三个头：

| 头 | 来源 | 备注 |
|---|---|---|
| `X-Client-Network` | `navigator.connection.type \|\| effectiveType`，正则 `/^[a-z0-9-]{1,16}$/` 不匹配则不发 | 如 `4g`/`wifi` |
| `X-Client-Surface` | `Q1()` → `miniprogram` \| `native` \| `h5` \| `pc` | `Hl()` 判宿主 |
| `X-Session-Id` | body 的 `sessionId`（body ≤64KB 且含 `"sessionId"`）→ URL `?sessionId=` → path 正则 `Z1` 匹配 | 只对同源 `/api*` |

插件复刻时要自己带这三个头——是否强校验未验证。

### 1. 认证端点（`dly-index.js` @241769 起 + `dly-ttb.js`）

| 方法 | 路径 | body / 说明 |
|---|---|---|
| GET | `/api/auth/config` | `{capabilities:{sms:{enabled},wechatPc:{enabled,appId,redirectUri},wechatMp:{...}}, smsAuthEnabled, passwordAuthEnabled, wechat:{appId,redirectUri}, wechatMP:{...}}`（`passwordEnabled` 在源码里被脱敏成 `n.passwordAuthEnabled===!0`，字段名应为 `passwordAuthEnabled`） |
| POST | `/api/auth/sms/send-code` | `{phone, purpose}` |
| POST | `/api/auth/sms/verify-code` | — |
| POST | `/api/auth/password{login\|register\|...}` | 模板串 `/api/auth/password${action}`，body 任意 |
| GET | `/api/auth/login-url` | `credentials:"include"` → `{state}` |
| POST | `/api/auth/wechat/login` | `{code, state}` |
| POST | `/api/auth/wechat-mp/login` | `{code, state}` |
| POST | `/api/auth/exchange` | `credentials:"include"`，换会话 |
| GET | `/api/auth/me` | 见下 |
| GET | `/api/auth/account` | 账号信息 |
| POST | `/api/auth/account/bind-phone` | `{phone, code}` |
| POST | `/api/auth/account/wechat-bind-intent` | `{provider}` → `data.state` |
| POST | `/api/auth/account/bind-wechat` | `credentials:"include"` |
| POST | `/api/auth/account/unbind-wechat` | — |

手机号正则 `^1[3-9]\d{9}$`。错误码形如 `PASSWORD_[A-Z0-9_]+`（`Ei()` 白名单校验）。

**`GET /api/auth/me` 响应**（`YD()` @1190877）：
```jsonc
{ "success": true,
  "data": {
    "user": {
      "id": "string", "displayId": "string?", "nickname": "string",
      "email": "string", "avatar": "string", "picture": "string",
      "authProvider": "wechat|wechat_mp|wechat_miniprogram|...",
      "userType": "string?",
      "productRole": "string?",
      "phoneBindingRequired": true,
      "isSystemAdmin": false,
      "accessInviteCode": "string?",
      "accountMergeSessionSourceUserId": "string?",
      "roleTags": "any?"
    },
    "inviteOnly": false,        // 邀请制开关
    "accessGranted": true,      // 是否已获准进入
    "loginTelemetry": { "is_first_login": "unknown" }
  } }
```
前端有 **1000ms TTL 的 per-access-code 内存缓存**（`p2` Map，`mr({fresh:true})` 绕过）。失败抛 `无法获取用户会话信息`。

**准入闸门**（`/api/access/*`）：`GET|POST /api/access/application`、`/api/access/journey`、`/api/access/redeem-invite`。`inviteOnly && !accessGranted` 时前端弹申请框。**这个状态必须映射进插件**——否则登录成功但一发消息就 `INVITE_REQUIRED`。

### 2. 积分/额度（`dly-ttb.js` @1350248 / @1353038 / `x1` @1351734）

`GET /api/credits` → `{success, data:{...}}`，前端解析（`x1`）：
```jsonc
{
  "balance": 123,                                  // 主余额（必须 isFinite）
  "creationCredits": { "available": 50, "expiresAt": 1730000000000 },  // 可 null
  "downloadQuota":   { "available": 5,  "expiresAt": null },
  "eggs": { "balance": 9 },        // 也兼容扁平 "eggBalance": 9
  "membershipTier":   "basic|advanced|premium|null",
  "membershipStatus": "active|expired|none",
  "hasActiveMembership": false,
  "membershipSkuCode": "string|null",
  "membershipExpiresAt": 1730000000000,
  "referralRemaining": 0,
  "nextReferralExpiresAt": null
}
```
- `eggs.balance` 优先，回落 `eggBalance`；都没有 = 0。
- `creationCredits` 缺失时回落 `balance`（**关键**：`creationCredits ?? balance`）。
- 前端 5s 节流（`BH=5e3`）。
- **balance 单位是「积分」**，插件 balance 字段直接给 `${balance} 积分`。

`POST /api/credits/checkin`（`silent:true`）→ `data:{alreadyCheckedIn, credits, balance, creationBalance, creationCredits}`。
**没有独立的「签到状态查询」接口**，签到前无法预知，只能 POST 后看 `alreadyCheckedIn`。

**checkin「六态」证伪**——实测只有：
1. `alreadyCheckedIn === true`（已签到，`credits` 为 0 或旧值）
2. `alreadyCheckedIn === false && (credits>0 || creationCredits>0)`（签到成功，弹窗）
3. HTTP 失败 → 前端 telemetry `result:"fail"`，静默吞掉

前端 `checkinModal.rulesStatus` 的 `ready|loading|error` 是 **UI 加载态**，跟签到状态无关。
登录后自动触发（`AppLayout` 里 500ms 定时 + 300ms 重试），没有手动按钮前置判断。

`GET /api/credits/grant-rules`（`UH()`，带 `Accept: application/json`，**走 `ya()` 不是 `le()`**）→
```jsonc
{ "success": true, "data": {
  "welcomeGiftCredits": 0, "dailyCheckinEggCredits": 1,
  "dailyCheckinCreationCredits": 0, "freeTierDownloadGrant": 0,
  "eggSupportDailyLimit": 1,
  "referralAcceptRewardCredits": 0, "referralFirstCreateRewardCredits": 0 } }
```

`GET /api/credits/download-file?artifactId=&artifactVersion=&voice=` → 二进制流。

### 3. 模型列表（`dly-index.js` @38987 `ad()`）

`GET /api/models`（`silent:true`，15s 超时）→
```jsonc
{
  "models": [
    { "id": "glm-5.3", "provider": "Auto", "icon": "url",
      "costMultiplier": 1.0,                               // 可缺省
      "reasoningEfforts": ["low","medium","high","max"] }  // 可缺省
  ],
  "defaultModel": "glm-5.3",
  "costMultiplierUpdatedAt": 1730000000000,
  "costMultiplierRefreshAt": 1730000000000,
  "pictureBookModelSelectable": false
}
```
- `reasoningEfforts` 长度 ≤1 时前端丢弃（`dd()`：`n.length>1 ? n : []`）——**单档等于没有**。
- 兜底档位表 `ud = {2:["low","high"], 3:["low","medium","high"], 4:["low","medium","high","max"]}`。
- 已知硬编码模型 id（`dly-ttb.js` 常量）：`auto`、`glm-5.3`、`glm-5.3-flashx`、`kimi-k3`、`kimi-k3.1-pro`、`hy3`。
- **没有图片/视觉能力字段**（无 `supportsImage`/`vision`/`capabilities`），插件别瞎猜。
- 无模型级错误码表；模型不可用走 chat 的 `MODEL_BUSY`/`MODEL_FAILED`。

### 4. 对话主链路（`dly-ttb.js` @1232935 `vz`/`Fj`/`Az`/`Hp`，`dly-engine.js` @11964）

**发送**：`POST /api/v3/chat`，`Content-Type: application/json`，完整 body：
```jsonc
{
  "messages": [ {"role":"user|assistant","content":"..."} ],
  "sessionId": "uuid",                  // 首条省略 → 服务端发 session-created
  "lang": "zh",                         // "zh"|"en"
  "contentMode": "...",                 // 可选
  "collectionId": "...", "knowledgeNodeId": "...",
  "activeSkillId": "@eureka/xxx",       // 来自输入框 @ 提及
  "queueItemId": "...", "materialUsageId": "...", "materialIds": ["..."],
  "references": ["..."],
  "displayContent": "...",
  "spreadsheetAttachments": [...], "uploadedFilePreviews": [...],
  "uploadedFiles": [...], "audioAttachments": [...],
  "hideFromChat": true, "isInteractionResult": true,
  "interactionType": "...", "transcriptDecision": "confirm|reject",
  "transcriptEditedText": "...",
  "askAnswer": "...",
  "images": [ {"base64":"...","mimeType":"image/png"} ],
  "extra": {
    "model": "auto|<模型id>",
    "modelUiId": "<同 model 或 ui 覆盖>",
    "modelSelectionSource": "unspecified|selector_click|...",
    "modelFromUiClick": false,
    "reasoningEffort": "low|medium|high|max",
    "artifactId": "...", "artifactVersion": 1,
    "selectedStyleId": "...", "selectedPictureBookStyleId": "...",
    "pictureBookRenderMode": "...", "contentType": "..."
  }
}
```
模型 id 兜底：`a || "auto"`。

**续流**：`GET /api/v3/chat/{sessionId}/subscribe`
**中止**：`POST /api/v3/chat/abort` body `{sessionId}`

**流格式——`data: ` 前缀 + `\n\n` 分帧**（`Hj()` @1233300 手写解析，**不是**标准 SSE，没有 event/id 行，也不校验 `text/event-stream`）：
```
data: {"type":"text-delta","delta":"你"}\n\n
data: {"type":"finish","stopReason":"completed"}\n\n
```
解析逻辑：按 `\n\n` 切块 → 块内找第一条 `startsWith("data: ")` 的行 → `slice(6).trim()` → `JSON.parse`。parse 失败只 `console.warn` 跳过。

**事件类型**（引擎 `onEvent` switch 穷举）：
| type | 载荷 |
|---|---|
| `session-created` | `{isNew:boolean, sessionId, requestId?, traceId?}` |
| `text-delta` | `{delta:string}` |
| `reasoning-delta` | `{delta:string}` |
| `tool-call` | `{toolCallId, toolName, displayName, icon, args, startedAt}` |
| `tool-result` | `{toolCallId, output:{data?:{title,pictureBookWorkflowId},error?}, finishedAt}` |
| `custom` | `{event:{...}}` — 子事件分发（`balanceAfter`→applyBalance、`searchCitations`→`record`、`inputImageModerationUnavailableCount`→`omittedCount`、artifact 类、ask-user 类） |
| `finish` | `{stopReason}` |
| `error` | `{code?, message?}` → **直接 throw `MastraStreamError`** |

**两个超时**（`Bj=60000`、`Dj=60000`）：首字节 60s、空闲 60s，任一超时 `reader.cancel()`。

**`stopReason` 枚举**（`St()` 校验）：`completed` / `stopped` / `max_duration` / `model_stalled` / `content_filter` / `insufficient_credits` / `error`。

**`error.code` 已知值**：`STREAM_NOT_FOUND`、`CHAT_REQUEST_FAILED`、`INSUFFICIENT_CREDITS`、`INVITE_REQUIRED`、`GENERATION_IN_PROGRESS`、`HTML_MODERATION_REJECTED`、`HTML_MODERATION_UNAVAILABLE`、`NOT_FOUND`，以及模型错误集 `jj = {MODEL_BUSY, MODEL_FAILED, CONTEXT_TOO_LONG, MODEL_REJECTED, UNKNOWN_ERROR}`。

HTTP 404 → `STREAM_NOT_FOUND`；`!ok` 或 content-type 含 `application/json` → 读 text，`r1()` 从 `{codeName|code|error.code}` 取码再 throw。

### 5. 会话 CRUD（`/api/eureka2`，`dly-ttb.js` @1227644 起 `as` 对象）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/eureka2/session` | body = 整个 session 对象（`Pj` 构造）。返回 `{session}` |
| GET | `/api/eureka2/session/{id}` | 支持 `signal`。非 ok 时 `err.status` 带状态码。返回 `{session}` |
| GET | `/api/eureka2/session/{id}/generation-status` | 返回 `{generating:boolean}`，非 boolean 报 `INVALID_GENERATION_STATUS_RESPONSE` |
| GET | `/api/eureka2/sessions?type={type}` | 返回 `{sessions:[...]}`，`messages` 缺省补 `[]` |
| DELETE | `/api/eureka2/session/{id}` | |
| POST | `/api/eureka2/session/{id}/share` | 公开；`DELETE` 取消公开 |
| POST | `/api/eureka2/session/{id}/title` | body `{title}` → `{title}` |
| POST | `/api/eureka2/session/{id}/summarize-title` | 无 body → `{title}` |
| POST | `/api/eureka2/session/{id}/pin` | body `{pinned:boolean}`；**404 时回落**：GET 全量 session 再 POST `/session` 覆盖 |
| GET | `/api/share/session/{id}?sec_token=` | 走裸 `fetch`，非 ok 或 `c2()` 真 → `Shared session not found` |

Session 对象字段（`Pj`）：`{...session, title:string, messages[]（createdAt/timestamp 统一转 ms）, createdAt:ms, updatedAt:Date.now(), pinnedAt:number|null}`。时间戳兼容 `_seconds`、`$date` 字符串。

**Artifacts**：`GET /api/v3/artifacts/{id}?includeBody=1[&sec_token=]` → `{artifact:{data,version,userVersion,title,remixSource}}`；`PATCH /api/v3/artifacts/{id}` body `{...patch, sourceVersion}`，409 = 版本冲突。

### 6. 其他端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/typing-completion` | `{draft, lang, activeSkillId?}`，流式，帧 `\n\n` + `data: {type:"completion"\|"done"}` |
| POST | `/api/speech/sessions` | 返回 `{success,data:{url(wss://asr.cloud.tencent.com/asr/v2/N), voiceId, expiresAt, maxDurationMs}}` |
| POST | `/api/chat-uploads` | 上传 |
| POST | `/api/chat-uploads/from-library` | |
| GET | `/api/chat-uploads/{id}/content` | |
| POST | `/api/message-feedback` | |
| GET | `/api/public-config` | |
| GET/PUT | `/api/profile` | PUT `{roleTags, personalizationLevel, language}` |
| PUT | `/api/profile/device` | `{onboarding}` |
| PUT | `/api/profile/user-type` | `{userType}` |
| PUT | `/api/profile/language` | |
| GET/PUT | `/api/profile/background` | |
| GET | `/api/plaza/official-account` | |
| — | `/api/referral/*` | `bind`/`entry/eligibility`/`me`/`miniprogram-code`/`rewards/read`/`rewards/unread`/`status`/`visit` |
| — | `/api/plaza/*` | `discovery/*`、`following-creators`、`following-updates/read`、`items/availability`、`items/{id}/creation`、`items/{id}/remix-tree`、`notifications`、`notifications/read`、`publish` |

静态资源 CDN：`dongleya.gtimg.com/prod/assets/*`；API 同源 `dongleya.qq.com`。
米大师收银台（membership 充值，按 Referer 白名单）——插件不用管。

---

## 规范要点（magpie-plugin-refactor skill，本机实测契约）

- 入口只导出一个插件函数；`config()` 静态模型表未登录也要有。
- auth.methods api 型的 `authorize(inputs)` 必须**直接返回** `type:"success"` 终态对象（宿主不调 callback）。
- balance 必须 `"N 积分"` 形式（宿主正则解析画走势图）。
- `usage.windows[].used` 必填 0-100，缺了按 0 算 = 满额度排队首（大坑 #1）。
- 模型级错误回 404；只有登录失效才 401。
- refresh 返回 patch 是**合并**语义；`expires:0` 永不续期。
- 上游 401 = `AuthExpiredError`，无 body 约定 → refresh 时探活 `/api/auth/me`，失效才 `signIn:"expired"`。
- **注意**：上游 `inviteOnly && !accessGranted` 要单独映射，不能当 401。

## 插件设计要点（据上文推导）

- **auth.methods**: `api` 型，输入 `eureka_token`（JWT 字符串，从浏览器 localStorage 抠）。`authorize()` 内先 `GET /api/auth/me` 验证，成功即 `type:"success"`。
- **模型表**: `GET /api/models` 动态拉；`config()` 里静态写死上文 6 个 id 兜底。
- **balance**: `GET /api/credits` → `${data.balance} 积分`。
- **usage**: `data.balance` / `creationCredits.available` / `downloadQuota.available` / `eggs.balance` 都能进 windows。
- **chat**: 解析 `data: ` + `\n\n` 分帧；`text-delta` 出内容，`reasoning-delta` 出思维链，`tool-call`/`tool-result` 可忽略或透传，`finish.stopReason !== "completed"` 要映射成对应错误。
- **checkin**: `POST /api/credits/checkin`，幂等（`alreadyCheckedIn`）。

## GitHub 侦察（S2）

**结论：没有。** 截至 2026-11-07，GitHub 上**零**个把懂了鸭（dongleya.qq.com / eureka2）包成 API 代理的项目。没有 one-api 供应商适配、没有 2api 反代、没有逆向工具。这个插件是首个实现——S5 之后没有现成代码可抄，也没有现成的 License 包袱。

### 搜过什么（gh cli，全量）

| 查询 | 类型 | 命中 | 结论 |
|---|---|---|---|
| `dongleya` | repos | **0** | 无同名/相关仓库 |
| `dongleya.qq.com` | repos | **0** | — |
| `dongleya --match name` | repos | **0** | — |
| `eureka2` | repos | 30+ | **全是同名噪声**：Spring Cloud Eureka 注册中心、BCI 脑电论文、学校项目。无一与腾讯懂了鸭相关 |
| `eureka2 2api` | repos | **0** | — |
| `懂了鸭` | repos | ~100 | **全是新闻搬运仓库**（TrendRadar / ai-daily / newTread 等转载 IT之家稿），无实现 |
| `懂了鸭 --match name` | repos | **0** | — |
| `dongleya.qq.com` | code JS | 1 | 仅 `crozier995/zhaowen` 新闻 JSON 里一段产品介绍文案 |
| `dongleya.qq.com` | code TS | **0** | — |
| `dongleya.gtimg.com` | code | **0** | 静态 CDN 域名无人引用 |
| `"dongleya" --filename package.json` | code | **0** | 无 npm 包 |
| `/api/v3/chat` + `eureka2` | code | **0** | 对话主端点无人写 |
| `/api/eureka2` | code | **0** | 会话 CRUD 端点无人写 |
| `eureka2.qq.com` | code | **0** | — |
| `dongleya` | code Python | **0** | — |
| `dongleya` | code Go | **0** | — |
| `dongleya` | code Rust | **0** | — |
| `懂了鸭` | code | ~40 | 全是新闻归档 md/txt/html，无一行代码 |
| `AhaDuck` / `奇妙卡` | code | 限流未取到 | 已知唯一提及者见下 |
| `dly-content-source` / `dongleya-content-asset-skill` / `dly-ca-skill` | code | 4 | **全部指向同一个仓库** `kms9/ai-tutor-awesome` |

顺带确认：`Sliverkiss` 账号下无 dongleya 相关仓库；`magpie-plugins` 不是 GitHub 组织（发布去向是 `github.com/Sliverkiss/magpie-plugins`，无独立 org）。

### 唯一值得看一眼的仓库（不是代理，是产品调研）

**`kms9/ai-tutor-awesome`** — https://github.com/kms9/ai-tutor-awesome
- **是什么**：AI 学习类产品的横向调研合集（markdown 文档），`product/dongleya/README.md` 一篇专讲懂了鸭。
- **能做什么**：**不能做任何 API 封装**。纯文档。产品形态、创作流程（绘本四步）、社区功能、定价（未商业化：创作积分 / 下载次数 / 鸭蛋）、风险全部记了访谈式笔记，多数标「未核」。
- **License**：无（`licenseInfo: null`）。0 star，最后更新 2026-11-06，无主语言（纯 md 仓库）。
- **代码质量一句话**：不存在代码——但调研纪律极好，信源逐条标注「未核」，比多数仓库的 README 老实。
- **可借鉴点（4 条，对 S6/S7 直接有用）**：
  1. **官方 Agent Token 而非 cookie 会话**：官网 `/tokens` 页可建个人令牌，有效期 7–180 天，MCP 走 `X-Agent-Token` 头。这比我们 S1 推断的 cookie 会话更稳、更适合插件长期驻留——S6 auth 可以优先探这条路。
  2. **官方 Skill 包**：`https://dongleya.qq.com/d_file/skills/dly-ca-skill-2.2.1.zip`（v2.2.1，2026-10-18 打包），内含 `dly-html` / `dongleya-content-asset-skill` / `dly-content-source` 三个 Skill。**这是官方授权的对外接口面**，里面必然有真实端点 + 鉴权样例，比啃 bundle 快得多——S6 之前先下这个 zip 拆。
  3. **上游模型清单**：IT之家口径为 DeepSeek / 混元 Hy3·Hy4 preview / MiniMax / Kimi / GLM。可交叉验证 `/api/models` 返回，也能反推 `extra.model` 合法取值。
  4. **`dly-content-source` 能用令牌取回本人作品源码**——说明存在「token → 内容」的读接口，可作为 checkin/usage 之外的能力点。

### 对后续步骤的影响

- S5 骨架无参考实现，按 `mimo2api` 结构走（S4 已定）。
- S6 顺序调整：**先拆官方 Skill 包 zip（拿端点+鉴权真样），再决定 cookie 会话还是 `X-Agent-Token`**。若 token 可用，插件 `refresh` 就不用探活 `/api/auth/me`，寿命也更长。
- 无需做 License 兼容性判断（无第三方代码可引入）。

## 参考插件

- mimo2api（结构最像）：`index.mjs` 单入口 + `src/{gateway,mimo}.mjs` + test/。
- richee2api（多账号、api 型 auth 的 authorize 形状参考）。

## 里程碑日志

- 2026-11-07 S0-S1：主链路端点与事件协议摸清（chatEngine-D86O1UCE.js / templateTelemetryBridge-zVVXgXml.js）。
- 2026-11-07 S1 复核：**推翻「cookie 会话」结论** → 实为 `Authorization: Bearer` + `localStorage.eureka_token`。补齐 authFetch 全判定链、`/api/auth/me`、`/api/credits`、`/api/models`、`/api/v3/chat` 完整 body 与流事件、`/api/eureka2` 全表、429 限流。checkin 六态证伪（只有 `alreadyCheckedIn` 布尔）。
- 2026-11-07 S1.5：官方 Skill 包（v2.2.1）拆包 + 在线探针。**Agent Token 只管 MCP 内容资产面，不能发对话**；对话面唯一凭据 = 浏览器 JWT（localStorage `eureka_token`）+ 浏览器 UA（缺 UA 即 403 Invalid client）。`/api/models` 公开无需登录。S6 定调：authorize 让用户贴 JWT。

## 逆向工具

- `reverse-bundles/_ctx.py` —— 从压缩 bundle 里按模式切上下文（`./_ctx.py PATTERN BEFORE AFTER [--all] [--files a.js,b.js]`）。别整文件读进 context。
- 2026-11-07 审查轮：三个 reviewer 并行找 bug，逐条修完后**新增 15 个回归测试**（67 pass / 0 fail，跑三遍稳定）。修掉的真问题：
  - **流式首个 `error` 帧永远漏检**（`new ReadableStream` 的 `start` 同步跑到第一个 `await` 就返回，放它后面的判断永远看到 `null`）→ 被封禁账号以 200 + error 帧出厂，magpie 无法标记，每轮回打。
  - **`Number(null) === 0`** 让 `retryAfterOf` 的「无意见」分支永不触发 → 每个 429 都带 `retryAfterSec: 0`，零秒退避重打直到封号。
  - `AuthExpiredError` 缺 `signIn: "expired"` → `refresh` 抛出的过期被当瞬时故障，`RENEW_RETRY` 无限重试死 token。
  - 非流式路径不认 `session-created`、不等 `finish`、不跑 `mapFinishReason` → 截断的生成被当正常完成全额收费。
  - `#fetch` 无超时 → 边缘挂住时整个会话闭包和 socket 一起被钉死。
  - 目录抓取失败无退避 → 供应商抖动变成每轮一次 `GET /api/models`，6h TTL 永不生效。
  - 邀请码文件非原子写、`clearInvite` 无条件清（并发登录互相擦）、`AUTHOR_INVITE` 未归一化。
  - in-band 错误码表与 `classify` 漂移（`HTML_MODERATION_REJECTED` / `CONTEXT_TOO_LONG` 落进 unknown）。
  - 取消流不断供应商（继续烧 token）、心跳帧不重置看门狗（健康的长流被误杀）、工具调用被静默拍平。
- 2026-11-07 工具轮：**推翻了 0.2.1 里「模型卡声明 `tool_call:false` 所以拒绝工具」的结论** —— `plugin.Model` 结构体没有 toolcall 字段，`host.js` 模型映射也不产出它，`modelEntry()` 写什么都到不了 Go；`gateway.go:1357` 的 `toolsTold` 对每个 chat 模型无条件设 `tool_call: true`。所以那个 400 拦截的是**每一次** agent 轮次，且插件无法靠声明摆脱。改成 `renderTools` 把工具清单渲染进 system 段（`<tool_call>{"name":…,"arguments":…}</tool_call>` 形状），assistant 的 `tool_calls` 和 `role:"tool"` 的结果分别还原成 `<tool_call>` / `<tool_result>` 文本，由 magpie 的 `textCallTidy` 还原成真调用（`passthrough` → `proto == Chat && sse && chatToolNames(body) != nil`）。顺带把 `retry-after` 那条 timing 脆的断言改成区间（HTTP 日期只有秒精度，`Math.ceil` 在 `login()` 之后跑必然少 1）。68 pass / 9 skip / 0 fail。
