# magpie-dongleya

magpie 供应商插件：把腾讯 **懂了鸭 (Dongleya / Eureka)** 的网页会话接成 OpenAI Chat Completions。

一个账号，10 个模型，推理档位可调，积分余额和每日签到直接显示在 magpie 账号卡片上。

---

## 装

```bash
magpie plugin install magpie-dongleya
```

或者从源码：

```bash
git clone https://github.com/Sliverkiss/magpie-dongleya
cd magpie-dongleya
bun install
magpie plugin link .
```

## 登录

两条路，任选。

**① 短信验证码**（推荐）

填手机号 → 服务端发 6 位码 → 贴码 → 完成。

发码走的是懂了鸭自己的 `POST /api/auth/sms/send-code`，不需要浏览器、不需要抓包。

> 少数号码会被服务端以 `official_code_required` 拒发，要求先走官方渠道验证一遍。
> 遇到就先去 [dongleya.qq.com](https://dongleya.qq.com) 用同一号码登录一次，回来再试。

**② 粘贴 Token**

在懂了鸭网页登录后，按 F12 打开 Console：

```js
copy(localStorage.eureka_token)
```

把剪贴板内容贴进 magpie 的输入框。插件会先打 `/api/auth/me` 验一遍再存。

## 邀请码

懂了鸭是**邀请制**。注册只需要手机号，但准入要邀请码——所以「登录成功」不等于
「能用」，新号的第一发消息会撞 `INVITE_REQUIRED`。

插件在登录时自己把这道门推开：

1. 登录成功 → 读 `/api/auth/me` 看 `accessGranted`。
2. 没准入 → 拿邀请码 `POST /api/access/redeem-invite`，再回读 `/api/auth/me`
   确认真的开了（兑换接口回 200 不算数）。
3. 进来了 → 读这个账号自己的 `GET /api/referral/me` 码，存成**下一个号**的邀请码。

也就是 A 邀请 B、B 邀请 C，一路滚下去。第一个号前面没人，退回作者码
`RMLM4C`（`DONGLEYA_INVITE` 可覆盖）。

码被上游判 `INVITE_INVALID` 时会自动丢掉，下次退回作者码，不会死循环重试。
兑换失败**不阻断登录**——账号是真的，只是还没准入，账号卡片会显示「准入状态」。

邀请码缓存在 `~/.cache/magpie/dongleya-invite*.json`。想钉死一个码不滚动，
在供应商编辑器里打开 **邀请码固定不滚动**。

## 模型

模型目录从 `GET /api/models` 实时拉，6 小时缓存。目录拉不到时回落到内置快照，不会出现「0 个模型」。

内置快照的 10 个：

| id | 供应商 | 推理档位 |
|---|---|---|
| `auto` | Auto | — |
| `deepseek-v4.1-flash-1017` | DeepSeek | low / medium / high / max |
| `deepseek-v4-pro-0813` | DeepSeek | low / medium / high / max |
| `hy4` | Hunyuan | low / medium / high / max |
| `hy4-preview` | Hunyuan | low / medium / high |
| `hy3` | Hunyuan | low / medium / high / max |
| `minimax-m3.1-flash` | MiniMax | low / medium / high / max |
| `minimax-m3` | MiniMax | low / medium / high / max |
| `kimi-k3.1-pro` | Moonshot | low / medium / high / max |
| `glm-5.3-flashx` | GLM | low / high / max |

`reasoningEffort` 从请求的 `reasoning_effort` 透传，`minimal` 映射成 `low`。

## 上游限制

读懂这些能省你不少排查时间：

- **上下文窗口上游不公布**。插件按 200k / 输出 32k 展示，真上限由服务端判定，超了回 `CONTEXT_TOO_LONG`。
- **图片不支持**。懂了鸭的模型目录里没有视觉能力字段，插件也不瞎猜。
- **工具调用不支持**。供应商只对自己的 Agent 开放工具，对第三方关闭。
- **UA 是硬校验**。`/api/v3/chat` 见不到浏览器 UA 就回 `403 Invalid client`，跟 token 有没有效无关。插件硬编码一份 Chrome UA，**失效了就是插件要更新**——不是你的号有问题。
- **没有 refresh token**。JWT 到期只能重登，插件会自动把账号标成需要重新登录。

## 错误映射

| 上游 | 插件 |
|---|---|
| `401 UNAUTHORIZED` / `INVALID_TOKEN` | 401 + `signIn:"expired"`，magpie 提示重登 |
| `403 FORBIDDEN "Invalid client"` | 502（UA 指纹过期，重登无用） |
| `INVITE_REQUIRED` | 403（邀请制，不是登录问题） |
| `INSUFFICIENT_CREDITS` | 402 |
| `MODEL_BUSY` / `GENERATION_IN_PROGRESS` | 503，magpie 可换号重试 |
| `MODEL_FAILED` / `MODEL_REJECTED` | 403 |
| `CONTENT_FILTER` | 400 |
| `code:10001 INVALID_INPUT` | 400，并把 `reason` 原文带给用户 |

## 签到

magpie 的 checkin 钩子接在 `POST /api/credits/checkin` 上。

懂了鸭没有「签到状态」查询接口——只能 POST 完读 `alreadyCheckedIn`。插件据此回 `claimed` / `done` / `inactive`，别指望能提前判断。

## 参考源

所有端点和协议都是从前端 bundle 和官方 Skill 包里读出来的，没有瞎猜。
拆出来的 bundle 在 `reverse-bundles/`（原站 `https://dongleya.gtimg.com/prod/`）：

| 本地文件 | 上游 | 读到了什么 |
|---|---|---|
| `dly-chat.js` | `chatEngine-D86O1UCE.js` | 对话协议、流式事件、错误码 |
| `dly-index.js` | `index-*.js` | 登录 / SMS / token / 邀请码 |
| `dly-tokens.js` | — | Agent Token 管理面（`/api/agent-tokens`） |
| `dly-engine.js` / `dly-x.js` | — | 模型目录、计费乘数 |
| `dly-ttb.js` | `templateTelemetryBridge-zVVXgXml.js` | 遥测（未接） |

拆包用 `reverse-bundles/_ctx.py`（按 pattern 取上下文，不整包读进模型）。

另外三处：

- **官方 Skill 包**：`https://dongleya.qq.com/d_file/skills/dly-ca-skill-2.2.1.zip`
  （v2.2.1，2026-10-18 打包）。里面是官方授权的 MCP 内容资产面
  （`X-Agent-Token` → `/api/mcp/agent/content-assets`），只覆盖作品发布，
  **不含对话**——对话面唯一凭据是浏览器 JWT。拆包见 `reverse-bundles/official-skill/`。
- **产品调研**：[`kms9/ai-tutor-awesome`](https://github.com/kms9/ai-tutor-awesome)
  （`product/dongleya/`），交叉验证了模型清单和「未商业化：创作积分 / 下载次数 /
  鸭蛋」的定价形态。
- **参考实现**：[`mimo2api`](../mimo2api)（单入口 + `src/` 结构）、
  [`richee2api`](../richee2api)（SMS 登录 + 多账号 auth 形状）。
  懂了鸭此前**没有公开的逆向实现**（GitHub 搜索零命中）。

## 开发

```bash
bun test                 # 67 条离线测试，全打 mock
bun run test:live        # 9 条真机契约测试，打 dongleya.qq.com（只碰公开接口）
node scripts/check.mjs   # magpie 插件合规检查
```

离线测试覆盖：`data:` 分帧（含 CRLF、跨 chunk 拆包、坏帧跳过）、OpenAI↔懂了鸭消息转译、模型解析、错误分类、完整登录链路、流式与非流式补全、usage/checkin/models 三个钩子。

真机测试覆盖：公开模型目录、auth config、四种错误 envelope 的确切形状、UA 闸门位置。全部无账号可跑。

---

MIT
