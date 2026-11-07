# CHANGELOG

## 0.3.1

### 修
- **模型描述符不再编造上下文窗口**。`limit: { context: 200_000, output:
  32_768 }` 是个圆整的占位数字——vendor 的 `/api/models` 不带这个字段，
  两份 bundle 里也翻不到，我们没有任何测量依据。这个数字被 magpie 拿去
  渲染卡片、算截断提示，等于给每个模型贴了一个假的 200k 上限。改成不写
  `limit`，由 magpie 用它自己的默认值接管；真实上限由上游用
  `CONTEXT_TOO_LONG` 兜，网关映射成 400。跟 `magpie-chatboxai` 的
  `contextOf()` 一个写法——量到了才发，没量到就不发。
- **测试钉住这个决定**。`provider.models` 断言 `hy4` 和 `auto` 都不带
  `limit`，免得以后有人手滑把数字塞回来。

## 0.3.0

照着 magpie 的文档和 `internal/plugin/host.js` 逐条对了一遍宿主契约：错误码回到宿主的冻结词表，两个不在表内的状态码归位，重定向不再带走凭据，工具能力补上声明。额度卡从一串数字改成带进度轨的窗口，图标换回 vendor 自己的官方标。

### 修

- **首字节超时是死代码**。`abort(reason)` 让 `fetch` 抛的是 reason 本身
  （`name` 是 `"Error"` 而不是 `"AbortError"`），所以 `e.name ===
  "AbortError"` 那个分支永远进不去：裸的英文 reason 一路漏到网关，被
  `errorStatus()` 当成未知错误映射成 502，这条路径存在的意义——504——丢了。
  改成看 controller 有没有被点燃，而不是看错误名。
- **超时常量伪造了 vendor 的归属**。注释写着「vendor's own first-byte
  ceiling」，但 vendor 的 bundle 里根本没有 60s：仅有的具名超时是
  `self_update` 的 30s 和 `preview` 的 5s，两个都不是聊天流，而推理模型的
  首 token 本来就比这两个都久。这两个值是插件自己的判断，需要它的原因是
  反过来的——magpie 对流式 `fetch` **没有任何 deadline**，只有
  `init.signal`，没有看门狗的话一条半开连接会把请求、客户端和 socket 一起
  钉住，直到 agent 放弃（而 agent 没有回合超时，所以是永远）。三个超时
  改成可注入，测试跑毫秒不睡觉。
- **目录失败退避在真正需要的场景里不可达**。它挂在 `if (s.catalog)` 的
  `else if` 上，只在「从没有过 catalog」时执行；而打爆 vendor 的恰恰是
  「有旧 catalog + vendor 挂了」——那里 `fresh` 为 false，走的是另一个分支，
  于是整段故障期间每轮对话都打一次 `GET /api/models`，6 小时 TTL 从不生效。
  改成无条件先判退避。
- **`scopeKey` 让所有账号塌进同一个 state**。`token.slice(0, 32)` 取的是
  JWT 的 header（`{alg,typ}` 的 base64url，第一个点之前有 36 字符），同一个
  issuer 签出来的每个 token 这个前缀完全一样。后果是一个共享的目录、一个
  共享的额度卡、一个共享的「已过期」标记，以及永远不触发的淘汰上限
  （`state.size` 恒为 1）。改成摘要整个 token，JWT 带 `userId` 时优先用
  更稳定的 `userId`。
- **网关的包装生成器从不解除内层迭代器**。`for await` 会调
  `events.return()`，它把包装生成器从 `yield` 处唤醒——但没有任何东西去
  唤醒 `iterator` 本身，于是内层永远挂在那里，捎带着两个 60s 定时器和整个
  响应闭包，每流式一轮泄漏一次。先 abort 再解绑：停在正文读取上的生成器，
  `.return()` 要等读取结束才 settle，而 `upstream.abort()` 正是结束读取的
  那一步。
- **错误码不是宿主词表里的词**。`STREAM_TRUNCATED`、`CONTENT_FILTER`、
  `INSUFFICIENT_CREDITS`、`MODEL_STALLED`、`CHAT_REQUEST_FAILED` 五个都是
  自己造的，agent 拿它分支匹配不到任何东西；`code` 还回退到 HTTP 状态
  数字，等于什么也没说。现在按 ERROR-CODES §3 的冻结表出词，`errorCode()`
  按类型映射而**不**透传 `err.code`——那几个类上它装的是 vendor 自己的业务
  码（`20003`、`INVITE_INVALID`）。流式错误帧补上 `status`：状态行已经
  花在 200 上，缺了它这条错误没有任何 magpie 能据以决定的信息。
- **两个状态码不在宿主表里**。402（积分不足）改成 502——额度是账号级的
  墙，换个账号就过得去，这正是 502 让 magpie 去做的事；4xx 只会让它对着
  一个没钱的账号反复重试。403（邀请门）改成 401 + `X-Magpie-Sign-In:
  kept`：既是访问问题、又不是会话过期，两个意思一起说，magpie 就不会去
  提供一个修不好任何东西的重新登录。

### 安全与能力

- **`fetch` 默认跟重定向，而凭据在 header 里**。`Authorization: Bearer <jwt>`
  跟着 3xx 走，就等于交给 `Location` 指到的任何主机。vendor 没有任何理由
  重定向一个 API 调用，所以改成 `redirect: "manual"` 并直接拒：3xx 是安全
  事件，不是路由细节。聊天流那条同样的口子一起堵上。
- **`capabilities.toolcall` 从来没声明过**。工具调用不是原生的——vendor 没有
  `tools` 字段，调用是以 `<tool_call>` 块写在回复正文里、由 magpie 再拎出来
  的。而 magpie 只看模型有没有被列成 tool-capable。不声明，模型就全是纯
  文本，提示词里根本不给工具，解析器也就没东西可拎。
- **上下文上限的注释在撒谎**。写着「保守下界」，但 200k 是个偏大的圆整数，
  而且 vendor 的 `/api/models` 和两个 bundle 里都没有这个字段——它不是量出来
  的。改成说实话：这是占位值，真实上限由上游用 `CONTEXT_TOO_LONG` 兜（网关
  映射成 400），所以猜大的最坏结果是一条明确的报错，不是静默截断。

### 额度卡

- **积分余额只有文字，没有进度条**。原来只有 `balance` + `unit`，magpie 只能
  当一串数字印出来。补上 `amount`（已消耗）和 `limit`（可消耗总量）——这一对
  正是宿主拿来画进度轨的口径——并显式给 `used`，不让条形取决于宿主自己的
  四舍五入。`balance` 留在同一行，宿主靠它给账号排序。
- **上限取 `balance + spent`，不取 `totalGifted`**。两者在没充过值时相等，
  充过之后就分叉，而只有这个和永远对得上真正在花的那个钱包。
- **`累计消耗` 那行删了**。它显示的是同一件事，只是没有形状；进度条把它说得
  更清楚，也没必要在一个钱包上开两行。

### 图标

- **`package.json` 里的图标不是这个产品的**。手绘了一张青色 SVG 顶上去，
  但仓库 `assets/icon.png` 一直是 vendor 的官方标（和
  `https://dongleya.gtimg.com/prod/favicon.png` 逐字节相同），只是从来没
  接上。图标改用 `assets/icon-96.png`，不再另画一个。

### 测试

98 通过 / 9 跳过 / 0 失败。新增 `test/host-contract.test.js` 十二条，各条
修复逐条回退验证过会红。（其中一条第一次写错：测试 body 漏了
`stream: true`，走的是非流式分支，旧代码下也是绿的。）`_internal` 是文档
认可的测试出口——magpie 把导出的**对象**当数据，不会当插件调用。

## 0.2.3

### 修

- **`refresh` 在续期窗口里每次请求都探活一次**。这个 JWT 没有 refresh
  token，续期只能重验、不能延长，但通过检查后返回的仍是同一个 `expires`。
  magpie 把下次续期排在 `expires − refreshLead`（11 行是 10 分钟），所以在
  这 10 分钟里 `renewAt` 一直在过去，于是**每一个**请求、`models`、`usage`、
  `checkin` 都重新打一次 `/api/auth/me`，还带一次 auth 文件锁和写入。
  现在通过探活后返回 `expires: 0`：token 不会变得更鲜，宿主也就不再排期，
  直到用户重新登录。提前死掉的 token 仍有兜底 —— loader 的 401 会带
  `signIn: "expired"` 把账号标记掉，这条路径本来就在。
  （`host.js:2639-2645` 的 `renewAt` + `2805-2830` 的 `renewLocked`。）

### 测试

69 通过 / 9 跳过 / 0 失败。新增一条：窗口内通过探活后 `expires` 为 0、
仍新鲜的 token 如实上报且**不**探活、整段只探一次。把修复回退后这条测试
按预期失败（`Received: 1794043330000`）。

## 0.2.2

工具调用从「拒绝」改成「真的能用」。

### 修

- **带工具的一律 400，等于 agent 全废**。原来的注释写「模型卡声明
  `tool_call:false`，所以 magpie 不该把工具路由到这里」——这句话是假的。
  `plugin.Model` 结构体里根本没有 toolcall 字段（`providers.go:61-128`），
  `host.js` 的模型映射（2418-2458）也不产出它，`modelEntry()` 写什么都会
  在序列化时丢掉；而 `gateway.go:1357` 的 `toolsTold` 对**每一个** chat
  模型无条件设 `tool_call: true`。所以 Cline / Kilo / Claude Code 每一轮
  都被 400，且没有任何办法通过声明摆脱工具。
- **改成把 tools 渲染进 prompt**。供应商的 `/api/v3/chat` 没有 `tools`
  字段，但 magpie 的 `textCallTidy` 会把模型写进正文的
  `<tool_call>{"name":…,"arguments":…}</tool_call>` 块还原成真调用（条件是
  `proto == Chat && sse && chatToolNames(body) != nil` —— 插件走的就是这条
  路）。`renderTools` 按这个形状把工具清单写进 system 段，`tool_choice:
  "none"` 时不写。
- **工具轮次不再被拍平**。之前 `contentText` 只留 `text` part、角色表只认
  user/assistant，带工具调用的历史到模型手上是半截。现在 assistant 的
  `tool_calls` 渲染回 `<tool_call>` 块，`role:"tool"` 的结果渲染成
  `<tool_result tool_call_id="…">` 挂在 user 侧（结果本来就是用户这一边的
  话），顺序、角色交替都不丢。

### 测试

68 通过 / 9 跳过 / 0 失败。旧的「工具被拒」回归换成三条：tools 进 prompt 且
请求成功、`tool_choice:"none"` 不带工具、`tool_call`/`tool_result` 三轮往返
后角色和内容都对。

## 0.2.1

审查轮。全部是「静默出错」类：没有一处会抛异常，每一处都让 magpie 拿着
错的信息做下一步决定。

### 修

- **流式首个 `error` 帧形同虚设**。`new ReadableStream({start})` 的 `start`
  同步跑到第一个 `await` 就返回，放在构造函数之后的判断永远看到 `null`。
  结果：被封禁的账号以 `200` + error 帧出厂，magpie 无法标记，每轮回打。
  现在先拉首帧再建流。
- **429 退避恒为 0 秒**。`Number(res.headers.get("retry-after"))` 里
  `Number(null) === 0` 且 `Number.isFinite(0)` 为真，「无意见」分支永不触发。
  零秒退避重打限流 = 直接进封号。同时把供应商的 `retry-after` 转发给客户端。
- **过期会话被当瞬时故障**。`refresh` 抛出的 `AuthExpiredError` 没带
  `signIn:"expired"`，magpie 走 `RENEW_RETRY` 无限重试死 token。现在直接
  冒泡，账号被正确标记。
- **非流式路径三种错报**：不认 `session-created`、不等 `finish` 帧、
  不跑 `mapFinishReason`。截断的生成被当正常完成、并全额计费。
- **`#fetch` 无超时**。非流式调用一个都不带 `signal`，边缘挂住时
  promise、会话闭包、socket 一起被钉死。补 30s 上限。
- **目录抓取失败无退避**。`force: !s.catalog` 在抓取失败后恒为真，
  6h TTL 永不生效，供应商抖动变成每轮一次 `GET /api/models`。失败后
  60s 内不再重试。
- **邀请码缓存三个竞态**：文件非原子写（崩溃留半截 JSON，`readJson`
  静默吞掉后所有记录退回默认）；`clearInvite` 无条件清（并发登录互相擦
  掉对方刚滚出的好码）；`AUTHOR_INVITE` 未归一化（小写环境变量永远兑换
  失败）。顺带补上从未清理的 `state` map（有 LRU 上限）。
- **in-band 错误码表与 `classify` 漂移**。`HTML_MODERATION_REJECTED` 落进
  unknown（502，magpie 会换号重打同一个违规 prompt）、`CONTEXT_TOO_LONG`
  落进 model-rejected（403，实际是 400）。同一条上游状况，取决于它从
  HTTP 信封还是流内帧到达而给出两个答案。
- **取消流不断供应商**。本地 teardown 不等于上游停下，生成仍跑完并计费。
  现在取消/hangup 时 `POST /api/v3/chat/abort`。
- **心跳帧不重置看门狗**。解析为 `null` 的 keep-alive 块到不了 `yield`，
  健康的长流被当成空闲超时掐掉。改成按帧重置。
- **工具调用被静默拍平**。`contentText` 只保留 `text` part、角色表只认
  user/assistant，带工具调用的对话到达模型时是半截。模型卡声明
  `tool_call:false`，现在直接 400 拒绝，不再自信地续写一段没发生过的对话。
- **模型目录回退没标记**。magpie 靠返回对象上的 `Symbol.for("magpie.fellBack")`
  判断是否回退，插件返回的是全新普通对象——编辑器和模型选择器把这些型号
  当成账号真实目录，每一发都 502。
- **`capabilities.reasoning` 位置错**。写到顶层 `reasoning` 而不是
  `capabilities.reasoning`，所有模型都被报成不支持推理，effort 变体挂在
  空处。补上 `input`/`output` 的 `text: true`（`kinds()` 只留 true 的项，
  全 false 等于「拒绝所有模态」）。
- **一次粘贴登录打两次 `/me`**。`identityOf` 读的就是同一个端点。
- **`累计消耗` 被当成窗口占比**。`amount` + `limit` 让 magpie 自己算
  `used = amount / limit * 100`（`plugin_usage.go:167`），于是「终身累计
  已用 / 终身累计发放」被画成一条爬到 100% 就永远不下来的曲线，卡片上还
  多一条进度条。这不是额度，是累计值 —— 改成纯 `display` 文本。

### 测试

67 通过 / 0 失败，连跑三遍稳定。新增回归：流式与非流式的 `INVITE_REQUIRED`
闸门、截断流、取消上游、工具拒绝、429 五种 `retry-after` 形态、目录失败
退避、`invite_fixed`、选项 key 正则、模型能力位置。

## 0.2.0

登录后自动过邀请闸门 —— 懂了鸭是邀请制，注册成功不等于能用。

### 准入（新）

- 真机确认：`/api/auth/me` 对新号回 `success:true` 但 `accessGranted:false`，
  第一发消息才 `INVITE_REQUIRED`。所以「登录成功」不是准入证明。
- **登录时自动兑换邀请码**：`POST /api/access/redeem-invite`，兑换后回读
  `/api/auth/me` 确认闸门真的开了（拿 200 不算数，`accessGranted` 才算）。
- **滚动邀请码**：账号登录成功后，用它自己的 `GET /api/referral/me` 码，
  作为下一个号的邀请码。A 邀请 B、B 邀请 C。第一个号没有人可跟，退回作者码。
- 码被上游判 `INVITE_INVALID` 时自动丢弃，下次退回作者码，不死循环重试。
- 插件选项「邀请码固定不滚动」：开则钉住当前码，不跟随登录变化。
- 兑换失败**不阻断登录**——账号是真的，只是没准入；`usage` 卡片会显示
  「准入状态 / 待审批」。

### 账号卡片

- 闸门关着时，`usage` 首行显示「准入状态」，而不是一个健康的积分余额配一个
  每次对话都 403 的 provider。
- 代码只读本插件自己的缓存（`~/.cache/magpie/dongleya-invite*.json`），
  不碰 magpie 的私有账号文件。

## 0.1.0

首个可用版本。

### 登录

- 短信验证码登录：`send-code` → 6 位码 → `verify-code` 换 JWT。真机验证 `smsAuthEnabled: true`。
- Token 粘贴兜底：`copy(localStorage.eureka_token)`，存前先打 `/api/auth/me` 验活。
- 账号卡片标题取昵称 → 掩码手机号 → userId。
- 无 refresh token 体系，`exp` 到期即标 `signIn:"expired"`。

### 对话

- `POST /api/v3/chat` 的 `data: ` 分帧流完整解析，支持流式与非流式两条路径。
- `text-delta` / `reasoning-delta` / `finish` 映射到 OpenAI 的 `content` / `reasoning_content` / `finish_reason`。
- `reasoning_effort` 透传，`minimal` 归一成 `low`。
- system 提示拼进第一个 user turn；同角色相邻消息合并；首尾多余 assistant turn 裁掉。
- 首字节 60s、空闲 60s 双超时，超时即中止上游。

### 模型

- `GET /api/models` 实时目录，6 小时 TTL，按账号隔离缓存。
- 目录不可用时回落 10 个模型的内置快照。
- `reasoningEfforts` 单档视为无档位（与前端 `dd()` 一致）。
- 未知模型回 404，不静默降级到 `auto`。

### 账号面

- `usage` 显示积分 / 创作积分 / 鸭蛋 / 会员档位。`used` 恒为 0——上游不给上限，不能假装 100% 已用。
- `checkin` 接懂了鸭每日签到，六态收敛成 `claimed` / `done` / `inactive`。

### 错误分类

真机采到的 envelope 全部命名归类：

- `401 UNAUTHORIZED` / `INVALID_TOKEN` → 会话失效
- `403 FORBIDDEN "Invalid client"` → UA 指纹过期（502，重登无用）
- `10001 INVALID_INPUT`（HTTP 200）→ 参数被拒，`reason` 原文透给用户
- `INVITE_REQUIRED` → 403；`INSUFFICIENT_CREDITS` → 402；`MODEL_BUSY` → 503

### 修掉的 bug

- CRLF 流不分帧：`indexOf("\n\n")` 在 `\r\n\r\n` 上永远不命中，整段响应堆到 EOF。改成正则分隔，并把 gateway 的分帧实现并回 `parseEventStream` 一处。
- `INVALID_INPUT` 挂在 HTTP 200 上被当成 502 上游故障。改成 `InvalidInputError` → 400，`reason` 不再被吞。
- `403 Invalid client` 原本没有分类，会落到通用 502 并让 magpie 以为是上游挂了。改成 `ClientRejectedError`，语义明确指向插件指纹。
