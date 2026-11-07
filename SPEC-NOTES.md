# SPEC-NOTES —— dongleya 插件开发规范笔记

> 本文是**施工规范**，不是进度记录（进度看 `PROGRESS.md`）。
> 每条结论都带 `文件:行号` 出处，可当场验证。冲突时以仓库里的真实代码为准。
>
> 依据来源：
> - `~/.config/magpie/library/skills/magpie-plugin-refactor/`（`SKILL.md` + `references/{HOOKS,GUIDE,CHECKLIST,AGENTS}.md`）
> - 四个真实插件：`magpie-plugins/{mimo2api,richee2api,dsh2api,magpie-edgeone}/`
> - 本机反编译宿主：`~/.cache/magpie/plugin-host/host-*.js`

---

# A · 供应商插件最小文件骨架

## A.1 目录约定

```
magpie-dongleya/
├── index.mjs                 # 只做装配：六个钩子的薄壳 + 常量
├── src/                      # 实现全在这
│   ├── dongleya.mjs          # 上游客户端（HTTP、会话、错误类型）
│   ├── gateway.mjs           # OpenAI ChatCompletions ⇄ 上游事件流转译
│   ├── models.mjs            # 目录三态降级
│   └── account-name.mjs      # accountId 规整（可选）
├── scripts/
│   ├── check.mjs             # 合规检查（退出码 0 = 合规）
│   ├── score.mjs             # 100 分卡（≥ 80 才能发）
│   └── publish-npm.mjs       # PUBLISH_AS 与包名不同时用
├── tests/
│   └── plugin.test.mjs       # 语义锁 + 挂载测试
├── .github/workflows/
│   ├── ci.yml                # check + test + pack --dry-run
│   └── release.yml           # tag + Release + npm（需 NPM_TOKEN）
├── package.json
├── registry-entry.json
├── README.md
├── CHANGELOG.md
└── LICENSE                   # 逐字 MIT 正文，归属写 NOTICE.md
```

⚠ **`scripts/` 和 `src/` 必须一起带走，不能只留 `index.mjs`**（`GUIDE.md:53-56`）。
`scripts/score.mjs` 打分时读的正是**你自己仓库里的** `scripts/check.mjs` —— 删了它，A 层直接 0 分。
`tests/` 里 `import` 的是 `../src/*.mjs`。

**成熟形态是 `index.mjs` 只装配，实现全在 `src/`**（`AGENTS.md:176`）。实测：`magpie-magicrew-auth` 的 `index.mjs` 只有 **86 行**，`src/` 27 文件 7773 行。

## A.2 `package.json`

字段全部来自 `dsh2api/package.json` / `magpie-edgeone/package.json`（两份都合规，可直接抄结构）。

```json
{
  "name": "magpie-dongleya",
  "version": "0.1.0",
  "description": "Dongleya 供应商插件 for magpie / OpenCode：<一句话说清签入什么服务、用户得到什么>",
  "type": "module",
  "main": "./index.mjs",
  "exports": "./index.mjs",
  "files": [
    "index.mjs", "src", "README.md", "CHANGELOG.md", "LICENSE",
    "registry-entry.json", "tests", "scripts"
  ],
  "keywords": [
    "magpie", "magpie-plugin", "opencode", "opencode-plugin",
    "opencode-auth", "provider", "dongleya"
  ],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/<owner>/magpie-dongleya.git" },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "magpie": {
    "name": "中文名 English",
    "icon": "data:image/svg+xml;base64,...",
    "maxConcurrency": 4
  },
  "scripts": {
    "test": "node --test",
    "check": "node scripts/check.mjs",
    "score": "node scripts/score.mjs",
    "publish:npm": "node scripts/publish-npm.mjs"
  }
}
```

### 逐字段硬约束

| 字段 | 约束 | 写错会怎样 | 出处 |
|---|---|---|---|
| `name` | **slug**：`^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$`。小写 ASCII，**不能有空格/中文/大写** | 带空格 → `magpie plugin update` 报 `unrecognised dependency format: 中文 名` | `CHECKLIST.md:77-83`、`AGENTS.md` 坑 28 |
| `magpie.name` | 显示名「**中文 + English**」，英文照抄厂商官方大小写（`华为云 HUAWEI`，不是 `Huawei`） | 卡片标题退回 slug | `GUIDE.md:65-66` |
| `magpie.icon` | `https://` 或 `data:image/`，≤ 1 MB | 插件列表那一行 / 详情页左上角是**灰方块** | `HOOKS.md` 一 |
| `keywords` | 必须**同时**含 `opencode` + `plugin`/`auth`/`provider` 之一 + `magpie` | magpie 的 Discover 里**搜不到** | `AGENTS.md` 坑 15 |
| `version` | 改代码必须 bump —— 同版本号重打包会命中 bun 缓存（`no changes`） | 改了重装**行为一点没变** | `AGENTS.md` 坑 10 |
| `repository` | 你自己的仓库地址 | 卡片上没有「源码」按钮 | `GUIDE.md:71` |

**`name` ≠ 显示名 ≠ npm 名**：
- `name` 只做 slug / bun 依赖键
- 显示名在 `package.json.magpie.name`（`shownName()` 优先取它）
- npm 名在 `scripts/publish-npm.mjs` 的 `PUBLISH_AS`
- `config.provider[id].name` 和 `registry-entry.json.name` **也放显示名**（可带空格）

**图标两个都要写**：`auth.icon`（供应商那一行的卡片）+ `package.json.magpie.icon`（插件列表/详情页）。只写 `auth.icon` → 后两处是灰方块。

### `registry-entry.json`

```json
{
  "package": "magpie-dongleya",
  "name": "中文名 English",
  "providers": ["dongleya"],
  "summary": {
    "en": "One sentence: what service, what the user gets.",
    "zh": "一句话：签入什么服务，用户得到什么。"
  }
}
```

`package` 是 **npm 包名**（不是显示名），`name` 才是显示名。形状照 `dsh2api/registry-entry.json`。

## A.3 `index.mjs` 导出形状

```js
// index.mjs —— 只做装配。实现全在 src/。
import { DongleyaClient, AuthExpiredError, DEFAULT_MODEL, truncateForLog } from "./src/dongleya.mjs";
import { handleChatCompletion, errorStatus, GatewayError } from "./src/gateway.mjs";

const PROVIDER = "dongleya";
const BASE = "https://<upstream-host>";          // loader baseURL

export const DongleyaPlugin = async ({ client }, options) => {
  const shared = makeClient(options);

  return {
    config: async (cfg) => { cfg.provider ??= {}; cfg.provider[PROVIDER] ??= { /* ... */ }; },

    auth: {
      provider: PROVIDER,
      refreshLead: 30 * 60 * 1000,
      methods: [ /* 见 B 节 */ ],
      async refresh(auth) { /* 见 B.3 */ },
      async loader(getAuth) { /* 见 B.4 */ },
      async usage(getAuth) { /* 见 A.5 */ },
      async checkin(getAuth) { /* 见 A.5 */ },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) { /* 见 A.6 */ },
    },
  };
};

/** 测试专用。⚠ 必须是对象，不是函数 —— 宿主把每个导出的函数都当插件调用。 */
export const _internal = { /* ... */ };
```

### 八个钩子（不是五个）

| # | 钩子 | 位置 | 职责 |
|---|---|---|---|
| ① | `config` | 顶层 | 静态模型表 —— **未登录也必须有** |
| ② | `auth.methods` | `auth` | 登录方式 |
| ③ | `auth.refresh` | `auth` | 续期 / 探活（**合并语义**） |
| ④ | `auth.loader` | `auth` | 每请求接管 |
| ⑤ | `auth.usage` | `auth` | 额度卡片 / 路由输入 |
| ⑥ | `auth.checkin` | `auth` | 每日签到 |
| ⑦ | `provider.models` | `provider` | 每账号动态目录 |
| ⑧ | `"chat.headers"` | 顶层 | 每请求加头 |

**入口只许导出一个插件函数**（`SKILL.md` 核心契约速查）。测试用的东西放 `export const _internal = {...}` —— 参考 `dsh2api/index.mjs:171-175`、`richee2api/index.mjs:555`。

### A.4 `config` 钩子

```js
config: async (cfg) => {
  cfg.provider ??= {};
  cfg.provider[PROVIDER] ??= {
    name: "中文名 English",                      // 供应商列表那一行
    npm: "@ai-sdk/openai-compatible",           // 决定 API 形状 + 自动加头
    api: BASE,                                  // 模型级 api 优先于 provider
    models: {
      [DEFAULT_MODEL]: {
        name: DEFAULT_MODEL,
        limit: { context: /* 实测值 */, output: /* 实测值 */ },
        reasoning: true,
        tool_call: true,                        // 写不写都一样，见下
      },
    },
  };
},
```

- **`config.models` 不能空** —— 它是 magpie 还没人登录时显示的模型列表。空 = 用户装上以为没装成（`README` 铁律 1、`AGENTS.md` 坑 5）。静态占位也算，登录后由 `provider.models` 覆盖。
- **`limit.context` 填实测值，不是猜的** —— 填错会让 agent 认为「放不下」而拒绝长输入（`CHECKLIST.md:43-45`）。
- ⚠ **`tool_call` 写了也没用**：`internal/plugin/providers.go` 的 `plugin.Model` 结构体里没有 toolcall 字段，`host.js` 的模型映射（2418–2458）也从不产出它 —— 所以 `config.models` 写 `tool_call`、`provider.models` 写 `toolcall`，两个都在序列化时被丢掉。真正决定「能不能调工具」的是 `gateway.go` 的 `toolsTold`，它对**每一个** chat 模型无条件设 `tool_call: true` + `supported_parameters: ["tools","tool_choice"]`。
- **推论：插件不能靠声明摆脱工具**。magpie 一定会把 `tools` 发过来。要么真的实现（把 tools 渲染进 prompt，模型用 `<tool_call>{"name":…,"arguments":…}</tool_call>` 写回，magpie 的 `textCallTidy` 还原成真调用 —— 前提是 `proto == Chat && sse && chatToolNames(body) != nil`），要么 400 掉，而 400 等于每一个 agent 轮次都失败。懂了鸭走的就是渲染进 prompt 这条路（`gateway.mjs` 的 `renderTools` / `renderToolCall`）。

### A.5 `usage` / `checkin`

```js
async usage(getAuth) {
  const auth = await getAuth();
  const token = tokenOf(auth);
  if (!token) return { error: "未登录" };
  try {
    const credit = await shared.creditInfo(token);
    return {
      user: auth?.nickName || auth?.userId || undefined,
      balance: `${credit.totalCredits} 积分`,     // ⚠ 必须是裸「数字 + 单位」
      windows: [{ name: "积分", balance: credit.totalCredits, unit: "积分" }],  // 钱包型：只给 balance，不给 used
    };
  } catch (e) {
    if (isAuthExpired(e)) return { error: "token 已失效，请重新登录", signIn: "expired" };
    return { error: truncateForLog(e.message, 200) };
  }
},

async checkin(getAuth) {
  const auth = await getAuth();
  const token = tokenOf(auth);
  if (!token) return { outcome: "failed", message: "未登录" };
  try { /* ... */ return { outcome: "claimed", credit, streak, message }; }
  catch (e) { return { outcome: "failed", message: truncateForLog(e.message, 200) }; }  // 永不 throw
},
```

出处：`richee2api/index.mjs:366-385`（usage）、`:419-461`（checkin）。

**`balance` 硬约束**（`SKILL.md` 本机实测 2）：必须是 `"N 积分"` **纯数字串**。宿主 `keysSum` 正则：

```
^([^\d-]*)(-?\d[\d,]*(?:\.\d+)?)(\D*)$
```

用它做三件事：多账号余额**加总**、`balanceTrend` **走势图**、卡片渲染。
**不能加非数字动态尾巴**（签到状态之类）—— 正则失配，总积分和走势图**全部消失**。

**`windows[].used` 必填且 `Number.isFinite`**（`CHECKLIST.md:27-29`）。漏了 = 报 0% = 满额 = **排在真在用的账号前面**。实测：一个余额 0 的号因为没上报 `used`，在路由组里 **256 次占了 255 次**，11 次被上游「余额不足」拒；补上后 **3/13 → 13/13**。

**`checkin` 六态**：`claimed` / `done` / `ineligible` / `inactive` / `captcha` / `failed`。时间口径**北京时间**，每账号每天一次，**抛异常等同 `failed` —— 永不 throw**。验证码返回 `captcha` 让用户去厂商 App 签，**永不解**。

### A.6 `provider.models`（三态降级）

```js
provider: {
  id: PROVIDER,
  async models(provider, { auth } = {}) {
    const token = tokenOf(auth);
    if (!token) return provider.models;
    const s = acctState(auth);
    try {
      const catalog = await loadCatalog(token, s, shared, { force: !s.catalog });
      if (!catalog?.length) {
        if (s.catalog) return listFromCatalog(s.catalog, provider);
        return provider.models;                  // 接口失败 → 保留原表，绝不返回空表
      }
      return listFromCatalog(catalog, provider);
    } catch (e) {
      if (isAuthExpired(e)) {
        state.delete(scopeKey(auth));            // 泄漏护栏
        throw Object.assign(new Error("会话已过期，请重新登录"), { signIn: "expired" });
      }
      return provider.models;
    }
  },
},
```

**三态方向必须各自选对**（`AGENTS.md` 坑 17）：

| 情况 | 返回什么 |
|---|---|
| 整个接口失败 | 退回上次快照 / `provider.models`，**不要返回空表** |
| 接口成功但单条缺字段 | **不列**那条（不猜） |
| 登录失效 | 抛 `signIn: "expired"` |

**空目录不要缓存** —— 缓存空表会把模型列表钉死在 `provider.models` 兜底上长达一个 TTL 周期（`richee2api/index.mjs:129-135`）。

### A.7 测试怎么跑

```bash
cd /Users/loh/data/FileSystem/magpie-plugins/magpie-dongleya

node --test                      # 语义（= npm test / bun test）
node scripts/check.mjs           # 合规：退出码必须 0
node scripts/score.mjs           # 打分：A/B/D 自动分 + C/E 待人工
npm pack --dry-run               # 打包面：README / CHANGELOG / docs 在不在包里
```

四条退出码全 0 才算「代码写完了」。**没过别往下走**（`GUIDE.md:218`）。

⚠ `tests/` 不是「照抄就能用」的通用测试 —— 它 `import` 的是 `../src/models.mjs`、`../src/gateway.mjs`，锁的是模板那套计费/降级实现。换成自己的实现就把对应断言一起改，否则它测的是模板（`GUIDE.md:213-216`）。

---

# B · Bearer token 型上游的 `auth.methods` 推荐写法

> 场景：上游是 **token 型**（`Authorization: Bearer <token>`），登录入口是**手机号 + 短信验证码**，token 不过期（`expireAt: null`）或长期有效，失效只能靠服务端撤销。

## B.1 为什么是 `type: "oauth"` + `method: "code"`

| 形态 | 形状 | 弹窗？ | 适用 |
|---|---|---|---|
| **A 浏览器 OAuth** | `{ url, method:"auto", callback }` | 会 | 厂商有标准 authorize 页 |
| **B 本机客户端导入** | `{ url, opened:true, method:"auto" }` | 不会 | 用户已装官方客户端 |
| **C 内置 headless 验证码** | `method:"code"` | 不会 | ⚠ 默认别选：滑块/风控/限流自己扛 |

出处：`HOOKS.md` 四之二。选择顺序 **B → A → C**。

**短信验证码登录 = 形态 C**：`authorize()` 里**发码**（一次网络调用，很快），返回 `{ instructions, method:"code", callback(code) }`；宿主展示 `instructions`、让用户贴码、**自己调 `callback(code)`** 完成登录。

`richee2api/index.mjs:186-231` 是完整范例，直接抄结构。

## B.2 骨架

```js
auth: {
  provider: PROVIDER,
  refreshLead: 30 * 60 * 1000,        // token 快过期前多久开始续期（不过期型可给大值）

  methods: [
    {
      type: "oauth",                                            // ① 宿主自己调 callback
      label: "短信验证码登录 / SMS code",
      prompts: [
        { type: "text", key: "phone", message: "手机号 / Phone number", placeholder: "1xxxxxxxxxx" },
      ],

      // ⚠ authorize 必须立刻返回 —— 只做「发码」，不要在这里等用户、不要做重活
      async authorize(inputs) {
        if (!inputs?.phone || !String(inputs.phone).trim()) {
          throw new Error("需要填写手机号 / phone number is required");
        }
        const phone = String(inputs.phone).trim();
        try {
          await shared.sendVerifyCode(phone);                   // ② 发码（唯一允许的网络调用）
        } catch (e) {
          throw new Error(truncateForLog(`验证码发送失败 / failed to send code: ${e.message}`, 500));
        }
        return {
          instructions: `验证码已发送到 ${phone}。请输入收到的验证码。`,
          method: "code",                                       // ③ code 契约
          async callback(code) {
            if (!code || !String(code).trim()) {
              return { type: "failed", error: "请输入收到的短信验证码" };
            }
            try {
              const sess = await shared.loginWithCode(phone, String(code).trim());

              // ④ 补一次 userinfo（换码响应常常没有账号名）
              if (!sess.userId || !sess.nickName) {
                try {
                  const u = await shared.userCurrent(sess.token);
                  sess.userId   = sess.userId   || u.userId;
                  sess.nickName = sess.nickName || u.nickName;
                } catch {}                                      // ⚠ 失败不能阻塞登录
              }

              const auth = {
                type: "success",                                // ⑤ 终态标记
                token: sess.token,
                access: sess.token,                             // 镜像，让账号在 magpie UI 里可读
                refresh: sess.token,                            // ⑥ save() 认 "refresh" → 按 oauth 形态存全部字段
                accountId: whoName(sess),                       // ⑦ 人读名：手机号（打码/昵称）→ 昵称 → 空串
                uid: sess.userId ?? "",                         // ⑧ 身份：内部 ID 只进这里
                userId: sess.userId ?? "",
                phone: sess.phone ?? "",
                nickName: sess.nickName ?? "",
                expires: 0,                                     // ⑨ 0 = 永不自动 OAuth 续期
                fetchedAt: Date.now(),
              };

              // ⑩ 预热目录：magpie 立刻显示真实模型
              try {
                const s = acctState(auth);
                await loadCatalog(sess.token, s, shared, { force: true });
              } catch {}

              return auth;
            } catch (err) {
              return { type: "failed", error: truncateForLog(err.message, 500) };
            }
          },
        };
      },
    },

    // 可选：手动粘贴 token（从网页 console / 官方客户端取）
    {
      type: "api",
      label: "手动填入 token / Paste token",
      prompts: [
        { type: "multiline", key: "key", message: "token（或完整的 auth JSON）",
          placeholder: '{"token":"...","userId":"...","phone":"..."}' },
      ],
      // ⚠ api 型：authorize 必须直接返回终态，宿主**从不调 callback**；失败只能 throw
      async authorize(inputs) {
        const token = tokenOf({ type: "api", key: inputs?.key });
        if (!token) throw new Error("需要填入有效的 token / a valid token is required");
        /* ... 探活 userCurrent 补齐 uid/nickName ... */
        return { type: "success", refresh: token, access: token, token, accountId: whoName(...), uid, expires: 0, fetchedAt: Date.now() };
      },
    },
  ],
},

// ---- 续期：token 不过期 → 只做探活 ----
refreshLead: 30 * 60 * 1000,
async refresh(auth) {
  const token = tokenOf(auth);
  if (!token) return;
  const s = acctState(auth);
  try {
    await shared.creditInfo(token);                 // ① 探活：有效就顺手保温
    await loadCatalog(token, s, shared, { force: !s.catalog });
  } catch (e) {
    if (isAuthExpired(e)) {
      throw Object.assign(new Error("token 已被服务端撤销；请重新登录"), { signIn: "expired" });
    }
    // ② 网络抖动：不上报过期，留给下次
  }
},

// ---- loader：每请求带 Authorization ----
async loader(getAuth) {
  const auth = await getAuth();
  const token = tokenOf(auth);
  if (!token) return {};                            // 未登录 → 宿主标准处理
  const s = acctState(auth);
  loadCatalog(token, s, shared).catch(() => {});    // 后台保温，绝不阻塞请求

  return {
    baseURL: BASE,
    apiKey: token,                                  // ③ sdkHeaders 会加 Bearer / x-api-key
    headers: { authorization: `Bearer ${token}` },  // ④ 显式覆盖，别依赖 sdk 默认
    async fetch(input, init) {
      let body;
      try {
        body = JSON.parse(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body ?? ""));
      } catch {
        return openaiBadRequest("request body is not valid JSON");
      }
      try {
        return await handleChatCompletion(shared, token, body, { signal: init?.signal });
      } catch (err) {
        if (err instanceof GatewayError) return err.toResponse();
        if (isAuthExpired(err)) {
          throw Object.assign(new Error(`上游拒绝了登录凭证；请重新登录 (${err.message})`), { signIn: "expired" });
        }
        const status = errorStatus(err);
        return new Response(
          JSON.stringify({ error: { message: err.message, type: "upstream_error", code: status } }),
          { status, headers: { "content-type": "application/json" } },
        );
      }
    },
  };
},
```

出处：`richee2api/index.mjs:177-290`（methods）、`:391-407`（refresh）、`:292-345`（loader）；`mimo2api/index.mjs:305-357`（loader 的 freshness gate 版本）。

## B.3 `refresh` 的合并语义（最容易静默出错的一条）

```js
async refresh(auth, provider) {
  return { access, refresh: newRefresh ?? auth.refresh, expires };   // 合并到旧账号
}
```

| 规则 | 说明 |
|---|---|
| **返回的是「合并」** | 只给新字段会**覆盖丢旧字段** → 用户被要求重登（`AGENTS.md` 坑 4） |
| `expires: 0` 或缺失 | **永不续期**（宿主不调 refresh） |
| 返回 `undefined` | 保持原样，不续期 |
| 抛 `{signIn:"expired"}` | 标记账号，不再重试直到重登 |
| 其它错误 | 30 秒后重试 |
| 串行化 | 同账号并发**只等一次**续期，最多 15 秒 —— 一次性 refresh_token 不会被用两次（`AGENTS.md` 坑 7） |

**单飞必须自己做**。`mimo2api/index.mjs:145-196` 的 `ensureFreshSession` 是完整实现：per-account `refreshPromise` 共享，晚到者 `await` 在途续期。不加锁 → renew→login 两条链并发 → 两次 `saveAuth` 竞争 → last-write 可能复活旧 cookie。**锁的键用凭据身份**（userId / cookie 前缀），不是 provider id。

## B.4 `loader` 契约要点

```js
return { baseURL, apiKey, headers, async fetch(input, init) { return new Response(...) } };
```

| 项 | 说明 |
|---|---|
| `baseURL` | 优先于模型 `api` 和 provider `api` |
| 头顺序 | `sdkHeaders(apiKey)` → `loader.headers` → gateway 请求头 → `"chat.headers"` 钩子（**后者覆盖前者**） |
| `init.body` | **JSON 字符串**；非 UTF-8 时是 bytes → 用 `typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)`（`dsh2api/index.mjs:96-98`） |
| `init.signal` | agent 放弃时 abort |
| 只看得到 | `POST {baseURL}/chat/completions`。`/v1/models` 由 magpie 网关自己答 —— **插件不开端口、不处理别的路径** |

⚠ **不要在 `fetch` 里读流** —— 把 `Response` 原样交回去，否则流式输出卡住 / 只有第一段（`AGENTS.md` 坑 8）。
⚠ **改写流式 body 要去掉 `content-length` 和 `content-encoding`**。

## B.5 `tokenOf()` 的容错写法

```js
function tokenOf(auth) {
  if (!auth) return "";
  if (typeof auth.token === "string" && auth.token.trim()) return auth.token.trim();
  // api 型 key（手动粘贴）：裸 token，或完整 auth JSON dump
  if (auth.type === "api" && typeof auth.key === "string") {
    const key = auth.key.trim();
    if (!key) return "";
    if (key.startsWith("{")) {
      try {
        const parsed = JSON.parse(key);
        return typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : "";
      } catch { return ""; }        // ⚠ JSON 但解析失败 → 不是有效凭证（原样当 token 只会得到 401）
    }
    return key;
  }
  return "";
}
```

出处：`richee2api/index.mjs:57-76`。

## B.6 `accountId` 是名字，`uid` 是身份

```js
function whoName(sess) {
  const phone = String(sess?.phone ?? "").trim();
  if (phone.length >= 7) return maskPhone(phone);   // 打码 189****8051
  const nick = String(sess?.nickName ?? "").trim();
  if (nick) return nick;
  return "";                                        // ⚠ 取不到就空串，让宿主回退供应商名
}
```

| 规则 | 说明 |
|---|---|
| 内部 ID（`iam::…` / `urn:` / uuid / 裸 hash / `hw0615…`） | **只进 `uid`**，绝不进 `accountId` |
| 写错的代价 | **永久性** —— `refresh` 返回合并、插件落盘又多保留旧值，URN 进去一次卡片就变不回来。**续期路径也要重算** |
| 手机号 | 去掉国家码后 ≥ 11 位才打码；短号返回空串不显示 |
| 去重 | `settle()` 按 `accountId`+`uid` 判 —— 同号重登是**替换**，不产生重复条目 |
| 存储键 | 第一个 `provider`，后面 `provider#a1b2c3` |

出处：`AGENTS.md` 坑 27、`HOOKS.md` 八、`CHECKLIST.md:71-75`。

## B.7 错误分层

| 情况 | 返回 | magpie 行为 |
|---|---|---|
| 模型不存在 | **404** + 错误 JSON | 只搁置**这个模型** |
| 登录被拒 | 401 或 `signIn:"expired"` | 标记**这个账号** |
| 401 是别的事 | 响应头 `X-Magpie-Sign-In: kept` | 不标记 |
| 已续期 | 响应头 `X-Magpie-Sign-In: renewed` | 清除标记 |
| 限流 / 5xx | 原样透传 | 自动换账号或模型 |
| 插件内部错误 | 抛异常 | 请求失败，故障转移继续 |

⚠ **401 用错会打死整个账号**：401 可重试 ⇒ failover 到**每一个**账号，每个都标登录失效（`AGENTS.md` 坑 6）。模型级错误一律 **403/404**。

---

# C · `check.mjs` / `score.mjs` 的位置和用法

## C.1 位置

⚠ **不在 skill 目录里。** `~/.config/magpie/library/skills/magpie-plugin-refactor/` 下只有 `SKILL.md` + `references/*.md`（4 份），**没有 `scripts/`，也没有 `src/`**。

本机有完整脚手架的仓库只有两个：

| 仓库 | 状态 |
|---|---|
| `magpie-plugins/dsh2api/scripts/` | `check.mjs`(521) / `score.mjs`(280) / `publish-npm.mjs`(44) |
| `magpie-plugins/magpie-edgeone/scripts/` | 同上 |

上游仓库：<https://github.com/MYCF711/magpie-plugin-scaffold>（本地没 clone，需要最新版就 `git clone` 刷）。

**dongleya 现在没有 `scripts/`** —— 从 `dsh2api/scripts/` 整个复制过来。

## C.2 `scripts/check.mjs`

```bash
node scripts/check.mjs              # 检查当前目录（严格：占位符会失败）
node scripts/check.mjs ../my-plugin # 检查别的仓库
node scripts/check.mjs --template . # 仅脚手架自身：允许「未命名」占位符
```

**退出码 0 = 合规，1 = 不合规**（CI 靠它卡门）。

它做的判断（`check.mjs:1-40` 头部 + 关键词常量）：

| 常量 / 正则 | 含义 |
|---|---|
| `PLACEHOLDER_PACKAGE_NAME = "unnamed-plugin"` | 派生项目不改就红 |
| `PLACEHOLDER_DISPLAY_NAME = "⚠ 未命名插件 Unnamed Plugin"` | 同上 |
| `PLACEHOLDER_PROVIDER_NAME = "⚠ 未命名供应商 Unnamed Provider"` | 同上 |
| `PLACEHOLDER_MARKERS = ["未命名", "Unnamed", "TODO"]` | 全文扫 |
| `NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/` | **与 magpie `internal/plugin/store.go` 的 `pkgName` 同一形状** |
| `isDisplayName = v => /[㐀-鿿]/.test(v) && /[A-Za-z]/.test(v)` | 显示名必须「中文 + English」 |

**它只查「能自动查的那部分」（约 30 条）**，`CHECKLIST.md` A 表里那些查不到，但漏了照样出事，而且**通常不报错**。

## C.3 `scripts/score.mjs`

```bash
node scripts/score.mjs                # 给自己打分（当前目录）
node scripts/score.mjs ../my-plugin   # 给别的仓库打分
node scripts/score.mjs --json         # 机器可读
```

**退出码：0 = ≥ 80 分（可以发布），1 = < 80 分。**

只算「能自动算的」：**A 合规（40 分）/ B 测试 / D 说明书**。**C 语义 与 E 发布算不了** —— 输出里明确标「待人工」并列出判据，绝不用「看起来没问题」凑分（`score.mjs:9-11`）。

关键实现细节（`score.mjs:38-40`）：

```js
const checkPath = [join(ROOT, "scripts/check.mjs"),
                   join(import.meta.dirname ?? ..., "check.mjs")].find(existsSync)
```

⇒ **优先用目标仓库自己的 `scripts/check.mjs`**，没有才用评分器自带那份。

**80 分 = 可以发布。低于 80 先补，别急着发**（`GUIDE.md:228`）。

## C.4 三个交付门

**门 1 · 代码交付**（给用户能装之前）

```
□ node scripts/check.mjs 退出码 = 0
□ CHECKLIST.md 的 A 表全勾（check 脚本查不到的那部分）
□ 五个 TODO 的语义按 HOOKS.md 对过一遍，不是「能跑就算」
```

**门 2 · 发布**（说「已发布」之前）

```
□ CHECKLIST.md 的 B 表全勾
□ 五条验证都跑过（含 check-maintenance.mjs）
```

⚠ **没过门 2 不许说「已发布」。** 只 push 过就说已发布，是在用印象代替验证（`AGENTS.md:159`）。

**B 表铁律：禁止直接推 `main`。** git 源用户跟随默认分支 HEAD，未验证提交一旦进去就直接抵达正在使用的人。唯一入口是功能分支经 PR 且 `rules` 全绿后合并。

```bash
git switch main && git pull --ff-only origin main && git switch -c feat/<改动>
npm version patch --no-git-tag-version          # + 写 CHANGELOG
node scripts/check.mjs && npm test && npm pack --dry-run
git push -u origin feat/<改动>
gh pr create --base main --fill && gh pr checks --watch
# 合并后：
node scripts/release.mjs --yes --npm            # tag + Release + npm
```

⚠ **npm 登记有 1-2 分钟延迟。** `npm publish` 返回成功时 registry 可能还查不到新版本 —— **别在这个窗口里当成失败重发**，重发会撞「同版本号已存在」（`CHECKLIST.md:141-142`）。

## C.5 其他可用脚本

```bash
node scripts/check-maintenance.mjs    # 改了代码有没有 bump / bump 了有没有打 tag / CHANGELOG 有没有这一节
node scripts/publish-npm.mjs          # 显示名与 npm 包名不同时发布（PUBLISH_AS）
node scripts/probe-vision.mjs         # 模型「说自己能收图」是不是真的（坑 25）
```

`check-maintenance.mjs` **六条全不报错，但后果同一个：用户永远拿不到新版。发布前必跑。**

---

# D · `data: ` 前缀 + `\n\n` 分帧的 JSON 事件流转译注意事项

> 场景：上游回 `content-type: text/event-stream`，帧是 `data: {json}\n\n` 形状，但**不是严格 SSE** —— 没有 `event:` / `id:` 语义，有的甚至只发裸 JSON 行。

## D.0 先说结论：HOOKS.md 没有专门章节讲这个

`references/HOOKS.md` 讲的是**插件侧**的字段形状（少写一个字段会怎样），**不涉及上游帧格式的转译**。这一节的规则全部来自**真实实现 + AI SDK 源码行为**，不是文档摘抄：

| 来源 | 提供什么 |
|---|---|
| `mimo2api/src/mimo.mjs:361-410` | `parseSSE` —— 通用 SSE 帧读取器（生产验证过） |
| `mimo2api/src/gateway.mjs:296-383` | 上游事件 → OpenAI SSE 的完整骨架 |
| `richee2api/src/gateway.mjs:171-300` | `streamPassthrough` —— 透传 + 每帧重建 |
| `dsh2api/src/chat.mjs:1201-1290` | 带心跳的版本（注释里写了每个坑的来历） |
| `@ai-sdk/provider-utils` | `parseJsonEventStream` 对 `[DONE]` 的比较方式 |

## D.1 帧读取器：不要自己写 `split("\n\n")`

```js
export async function parseSSE(body, onEvent, signal) {
  const decoder = new TextDecoder();
  let buf = "";
  let cur = { id: "", event: "", data: "" };
  const flush = async () => {
    if (cur.event || cur.data) {
      await onEvent({ id: cur.id, event: cur.event, data: cur.data });
      cur = { id: "", event: "", data: "" };
    }
  };
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });   // ① 跨块 UTF-8
      if (done) buf += decoder.decode();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");          // ② CRLF
        buf = buf.slice(nl + 1);
        if (line === "") {
          await flush();                                           // ③ 空行 = 一帧结束
        } else if (line[0] !== ":") {                                // ④ 跳过 `: ping` 注释
          const i = line.indexOf(":");
          if (i >= 0) {
            const name = line.slice(0, i);
            let val = line.slice(i + 1);
            if (val.startsWith(" ")) val = val.slice(1);           // ⑤ 单个前导空格是格式的一部分
            if (name === "id") cur.id = val;
            else if (name === "event") cur.event = val;
            else if (name === "data") cur.data = cur.data ? cur.data + "\n" + val : val;  // ⑥ 多行 data 用 \n 拼
          }
        }
      }
      if (done) { await flush(); return; }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
```

**六个必须处理的点**（`mimo2api/src/mimo.mjs:365-410`）：

| # | 点 | 不处理会怎样 |
|---|---|---|
| ① | `decoder.decode(value, { stream: true })` | **中文/emoji 跨 chunk 被切成乱码**（UTF-8 多字节被 block 边界劈开） |
| ② | `.replace(/\r$/, "")` | 上游发 CRLF 时 `data` 值尾部带 `\r`，`JSON.parse` 报 `Unexpected token` |
| ③ | 空行 = 一帧结束 | 一帧多行会粘成一条废数据 |
| ④ | `line[0] !== ":"` | `: ping` 心跳注释被当数据解析 |
| ⑤ | 值前**单个**空格才剥 | `data:  123` 剥多了会破坏内容 |
| ⑥ | 多行 `data` 用 `\n` 拼 | 标准允许 `data:` 重复出现，只留最后一行会丢内容 |

⚠ **如果上游发的是裸 JSON 行（没有 `data: ` 前缀）** —— 例如 dsh2api 的 EdgeOne 上游 —— 那上面这套**不能直接抄**，要写行切分（同样带 ① 的 `stream: true` 和 ② 的 `\r` 容错）。**先确认上游到底发不发 `data: ` 前缀**，这决定用哪个切分器。

## D.2 出口方向：必须发合法 OpenAI SSE

```js
const send     = (obj) => ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
const sendDone = ()    => ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
```

### ⚠ `[DONE]` 必须是**裸字面量**

```js
// ❌ JSON.stringify("[DONE]") → "\"[DONE]\""
//    AI SDK 的 parseJsonEventStream 把它当 data 帧 → chunk schema 报
//    "expected object, received string" → run 以错误收尾而不是干净停止
// ✅ 判据在 @ai-sdk/provider-utils：
//    if (data === "[DONE]") return;
//    比较的是裸字面量，JSON.stringify 绝不能碰它
```

出处：`mimo2api/src/gateway.mjs:305-314`（注释里写明了这条是怎么被实测出来的）。

## D.3 200 状态码必须用第一个上游事件来 gate

```js
let gotFirst = false;
const firstGate = new Promise((resolve, reject) => {
  const pump = (async () => {
    try {
      send(textChunk(id, model, created, { role: "assistant", content: "" }));
      const result = await runTurns((piece) => {
        send(textChunk(id, model, created, piece.type === "reasoning"
          ? { reasoning_content: piece.text } : { content: piece.text }));
        if (!gotFirst) { gotFirst = true; resolve(); }
      });
      /* ... citations / finish / sendDone / ctrl.close() ... */
    } catch (err) {
      if (!gotFirst) {
        gotFirst = true;
        reject(err);          // ← 头还没发：抛给 loader 映射 signIn:"expired"
        return;
      }
      // 头已发：错误只能回退成流内错误对象
      if (!closed) {
        send({ error: { message: err.message, type: "upstream_error", code: errorStatus(err) } });
        sendDone();
        closed = true;
      }
      try { ctrl.close(); } catch {}
    }
  })();
  pump.catch(() => {});       // rejection 通过 firstGate 消费
});
await firstGate;
return new Response(readable, {
  status: 200,
  headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
});
```

出处：`mimo2api/src/gateway.mjs:325-383`。

**为什么必须 gate**：登录失效必须 `throw` 出 `handleChatCompletion`，让 `loader` 映射成 `signIn:"expired"` 去标账号 —— 不能变成**已经 200 的流里的一帧 error**，那样 magpie 看不到、账号不标、下次继续打。

**退化情形**：一个事件都没收到就结束（空 turn）也要 `resolve()`，headers 照样 200。

## D.4 取消传播：消费者死了要拆上游

```js
const pumpAbort = new AbortController();
const effSignal = signal ? AbortSignal.any([signal, pumpAbort.signal]) : pumpAbort.signal;

const readable = new ReadableStream({
  start(c) { ctrl = c; },
  cancel() {
    closed = true;
    pumpAbort.abort(new Error("consumer cancelled the response"));   // ← 拆上游
  },
});
```

不拆的后果：`ReadableStream.cancel()` 之后 pump 还在往上游读（更糟：继续拨剩下几轮 replay）—— 对着死消费者的连接/turn 风暴。

出处：`mimo2api/src/gateway.mjs:248-256`、`:315-323`。

## D.5 每轮子步骤要有自己的预算

```js
const IMAGE_CHAIN_MS = 180_000;
const imgSignal = AbortSignal.any([effSignal, AbortSignal.timeout(IMAGE_CHAIN_MS)]);
```

`fetchImageBytes` / `uploadFile` / `parseResource` 只在**不传 signal** 时才用自己那个短超时。把调用方的 signal 直接传下去 → 卡住的上传/解析**没有自己的天花板** → 整条请求永久挂在两轮之间的空档。每轮重新 armed，这样早先那轮的超时不会误杀后面那轮的图片。

出处：`mimo2api/src/gateway.mjs:264-274`。

## D.6 透传模式：每帧重建，别直接转发

上游帧**不能原样转发给客户端** —— 至少两处必须重写：

```js
function rebuildChunk(chunk, fallbackModel) {
  // ① 上游回的 model 名可能是内部 id，客户端按请求时的 id 匹配会失败
  if (!chunk.model) chunk.model = fallbackModel;
  // ② tool_calls 的 function 可能不是对象（有的上游回字符串）
  //    ...tc.function && typeof tc.function === "object"...
}
```

- 需要改就 **`structuredCloneSafe` 先复制**（`richee2api/src/gateway.mjs:158`），别就地改上游对象 —— 有的 SDK 会复用。
- **上游错误帧要包成 `{ error: {...} }` 再发**，然后 `[DONE]` 收尾（`richee2api/src/gateway.mjs:278-280`）。
- **上游 `content-type` 不是 `text/event-stream` 时要单独处理**（`richee2api/src/gateway.mjs:81`）—— 有的网关错误页回 `application/json`，直接当 SSE 读会得到零帧的静默空流。

## D.7 心跳

```js
const beat = setInterval(() => {
  if (Date.now() - lastWrite < heartbeatMs) return;
  lastWrite = Date.now();
  try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}   // 注释帧，所有 parser 都忽略
}, Math.max(20, Math.min(5_000, Math.floor(heartbeatMs / 3))));
```

上游跑沙盒工具时长时间静默，客户端流 10s+ 没字节会招中继代理切流。**真实 delta 要重置时钟。** 出处：`dsh2api/src/chat.mjs:1215-1227`。

## D.8 非流式路径

`body.stream !== true` 时要**折叠**上游全部事件再回一个 JSON body：

```js
{
  id, object: "chat.completion", created, model,
  choices: [{ index: 0, message: { role: "assistant", content, reasoning_content? }, finish_reason: "stop" }],
  usage: { prompt_tokens, completion_tokens, total_tokens },   // 上游没给就估算
}
```

**`usage` 必须发**。很多上游不吐 `usage` 事件，缺了 magpie 的额度显示会停在 0。估算约定：**~4 字符 / token**，且要按 **Unicode code point** 数（`s.length` 会把 CJK 多算约 2 倍）—— 见 `mimo2api/src/gateway.mjs:61-76` 的 `countChars` 实现（surrogate pair 算一个）。这是**展示与配额**口径，不是计费口径。

## D.9 转译层检查清单

```
□ parseSSE 用 TextDecoder(..., { stream: true })，UTF-8 跨块不乱码
□ 每行 .replace(/\r$/, "")，CRLF 上游不炸
□ 空行 flush；`:` 开头跳过；data 多行用 \n 拼
□ 确认上游到底发不发 `data: ` 前缀（不发 → 换行切分器）
□ 出口 `[DONE]` 是裸字面量，没经过 JSON.stringify
□ 200 由第一个上游事件 gate，头发出前的错误能 throw 到 loader
□ 头发出后的错误回退成 {error:{...}} 帧 + [DONE]
□ ReadableStream.cancel() 会 abort 上游
□ 每轮子步骤（图片/上传）有自己的 AbortSignal.timeout
□ 出站帧 model 字段被重建成请求时的 id
□ 非流式路径折叠完整 + usage 估算（4 字符/token，按 code point 数）
□ 心跳 `: ping\n\n`（静默超时后发，真实 delta 重置时钟）
□ fetch 里不读流，Response 原样交回
```

---

# 未完成

| 项 | 原因 |
|---|---|
| `scripts/check.mjs` 521 条规则逐条读完 | 只读了头部 40 行 + 全部关键词常量 + 从 `CHECKLIST.md` 反推的规则面。要逐条对得上，得把文件通读一遍 —— 但它是**通用脚手架检查器**，dongleya 直接复制过来跑、按报错改，比预先读完更省 |
| `richee2api/src/gateway.mjs` 全文 | 只按 `grep` 定位读了行号（`:81` content-type 检查、`:158` `structuredCloneSafe`、`:171-300` `streamPassthrough`、`:310` `rebuildChunk`、`:278-280` 错误帧）。D 节引用的都是这些已确认的行 |
| `HOOKS.md` 里「非标准 SSE 转译」的专门章节 | **不存在**。见 D.0 —— 该文档讲插件侧字段形状，不讲上游帧格式 |
| S2 起的 GitHub 侦察 / S3-S9 | 不在本次任务范围（本次只要 A/B/C/D 四节规范） |
| dongleya 上游的实际帧格式验证 | 需要真实抓一次 `POST /api/v3/chat` 的响应体，确认到底发不发 `data: ` 前缀、`\n\n` 还是单 `\n` 分帧。**这是 D 节唯一必须实测才能定的岔路** |
