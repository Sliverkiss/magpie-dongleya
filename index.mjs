// index.mjs — magpie plugin: 懂了鸭 (dongleya.qq.com) reverse proxy.
//
// Turns a 懂了鸭 (Eureka) account into a magpie provider: SMS-code login,
// JWT session, the vendor's `data:`-framed `/api/v3/chat` stream mapped onto
// OpenAI Chat Completions, reasoning deltas, per-account model catalog,
// credits display, and the daily checkin hook.
//
// Session shape (magpie stores it per account in plugin-auth.json):
//   { type: "oauth",
//     access, refresh,     ← mirrors of the JWT, so magpie can display/renew
//     token,               ← the real credential (`eureka_token`)
//     expires,             ← epoch ms decoded from the JWT's exp
//     userId, label }      ← account identity for the card title
//
// Why no browser OAuth: the vendor's WeChat login redirect_uri is pinned to
// dongleya.qq.com by the WeChat open platform whitelist, so a loopback
// callback can never receive the code. The SMS path below is the vendor's
// own login route and needs no browser at all.

import { createHash } from "node:crypto";
import {
  AUTHOR_INVITE,
  clearInvite,
  nextInvite,
  noteAccountCode,
  normaliseCode,
  readInvite,
  writeInvite,
} from "./src/invite.mjs";
import {
  DongleyaClient,
  AuthExpiredError,
  InvalidInputError,
  InviteInvalidError,
  accessOf,
  jwtExpiry,
  decodeJwt,
  maskPhone,
} from "./src/dongleya.mjs";
import { handleChatCompletion, errorStatus, GatewayError, openaiError } from "./src/gateway.mjs";

const PROVIDER = "dongleya";
const BASE = "https://dongleya.qq.com";

// The vendor publishes no context window per model. These limits are a
// conservative floor used only for magpie's display and truncation hints —
// the upstream enforces its own ceiling and answers CONTEXT_TOO_LONG.
const LIMIT_DEFAULT = { context: 200_000, output: 32_768 };

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** After a failed catalog fetch, wait this long before asking again. */
const CATALOG_FAIL_TTL_MS = 60 * 1000;
/** How many accounts' catalogs to keep before evicting the coldest. */
const MAX_TRACKED_ACCOUNTS = 256;
const REFRESH_LEAD_MS = 10 * 60 * 1000;

// Snapshot of GET /api/models. Used before the first catalog fetch and
// whenever the upstream list is unavailable, so the provider never shows
// "0 models". `efforts` mirrors the vendor's reasoningEfforts.
const FALLBACK_MODELS = [
  { id: "auto", label: "Auto", provider: "Auto", cost: 1, efforts: [] },
  {
    id: "deepseek-v4.1-flash-1017",
    label: "DeepSeek V4.1 Flash",
    provider: "DeepSeek",
    cost: 0.5,
    efforts: ["low", "medium", "high", "max"],
  },
  {
    id: "deepseek-v4-pro-0813",
    label: "DeepSeek V4 Pro",
    provider: "DeepSeek",
    cost: 2.217977553962781,
    efforts: ["low", "medium", "high", "max"],
  },
  { id: "hy4", label: "Hunyuan 4", provider: "Hunyuan", cost: 1.5854404607118366, efforts: ["low", "medium", "high", "max"] },
  {
    id: "hy4-preview",
    label: "Hunyuan 4 Preview",
    provider: "Hunyuan",
    cost: 3.1708809214236733,
    efforts: ["low", "medium", "high"],
  },
  { id: "hy3", label: "Hunyuan 3", provider: "Hunyuan", cost: 0.9912282871219202, efforts: ["low", "medium", "high", "max"] },
  {
    id: "minimax-m3.1-flash",
    label: "MiniMax M3.1 Flash",
    provider: "MiniMax",
    cost: 0.6708620129119722,
    efforts: ["low", "medium", "high", "max"],
  },
  {
    id: "minimax-m3",
    label: "MiniMax M3",
    provider: "MiniMax",
    cost: 1.8573230110090688,
    efforts: ["low", "medium", "high", "max"],
  },
  {
    id: "kimi-k3.1-pro",
    label: "Kimi K3.1 Pro",
    provider: "Moonshot",
    cost: 9.290695788197677,
    efforts: ["low", "medium", "high", "max"],
  },
  {
    id: "glm-5.3-flashx",
    label: "GLM 5.3 FlashX",
    provider: "GLM",
    cost: 2.0963677342704385,
    efforts: ["low", "high", "max"],
  },
];

// ---------------------------------------------------------------------------
// session helpers
// ---------------------------------------------------------------------------

/** Pull the credential out of whatever shape magpie stored. */
function sessionOf(auth) {
  const token = auth?.token || auth?.access || (auth?.type === "api" ? auth?.key : "") || "";
  if (!token) return null;
  return {
    token: String(token),
    userId: auth?.userId || auth?.uid || "",
    phone: auth?.phone || "",
  };
}

/** Build the oauth-shaped session magpie saves. */
function authWithSession(prev, sess) {
  const payload = decodeJwt(sess.token);
  const exp = jwtExpiry(sess.token);
  const userId = sess.userId || String(payload?.userId ?? payload?.sub ?? payload?.id ?? "");
  const label = sess.label || sess.phone || "";
  const next = {
    ...prev,
    type: "success",
    token: sess.token,
    access: sess.token,
    refresh: sess.token,
    expires: exp ?? 0,
    userId,
    uid: userId,
    phone: sess.phone ?? prev?.phone ?? "",
    label,
    accountId: label || userId,
    fetchedAt: Date.now(),
  };
  delete next.error;
  return next;
}

// Per-account in-memory state, keyed by a per-account scope (never by
// provider id — magpie runs every call inside an account scope).
const state = new Map();

function scopeKey(auth) {
  if (auth?.userId) return `u:${auth.userId}`;
  if (auth?.uid) return `u:${auth.uid}`;
  if (auth?.accountId) return `a:${auth.accountId}`;
  if (auth?.token) {
    // A JWT's first 32 characters are its *header* — base64url of
    // {alg, typ}, 36 chars before the first dot — and that is
    // byte-identical for every token the same issuer mints. Keying on
    // `token.slice(0, 32)` therefore collapsed every account into one
    // entry: one shared catalog, one shared quota card, one shared
    // "expired" flag, and the eviction cap never kicking in because
    // `state.size` was always 1. Digest the whole token instead.
    return `t:${createHash("sha256").update(auth.token).digest("hex")}`;
  }
  return "default";
}

function acctState(auth) {
  const key = scopeKey(auth);
  const seen = state.get(key);
  if (seen) {
    // Re-insert so Map iteration order stays least-recently-used first.
    state.delete(key);
    state.set(key, seen);
    return seen;
  }
  // Nothing in the hook surface says "this account was removed", so entries
  // are otherwise immortal: a JWT that carries no userId keys on a digest
  // of its token, and every re-login mints a new one, orphaning the old
  // entry forever. Cap the map and evict the coldest.
  if (state.size >= MAX_TRACKED_ACCOUNTS) state.delete(state.keys().next().value);
  const s = { catalog: undefined, catalogAt: 0, catalogFailedAt: 0, catalogPromise: null };
  state.set(key, s);
  return s;
}

// ---------------------------------------------------------------------------
// model catalog
// ---------------------------------------------------------------------------

/** FALLBACK row -> magpie model entry. */
function modelEntry(row) {
  const variants = {};
  for (const e of row.efforts ?? []) variants[e] = {};

  // Everything here is read off `capabilities`, never the top level. Two
  // shapes are load-bearing and both used to be wrong:
  //
  //   reasoning  — the host reads `capabilities.reasoning`. A top-level
  //                `reasoning: true` is ignored, so every model reported as
  //                non-reasoning and the effort variants had nothing to hang
  //                off.
  //   input      — `kinds()` keeps only the kinds set to `true`, and
  //                `inputSaid()` calls any all-false input "said no to each
  //                kind" (#3279, the embedding shape). `{image:false}` alone
  //                therefore declared every dongleya model as taking no
  //                input modality at all. `text:true` is what makes it a
  //                real modality list.
  //
  // `variants` stays empty for a model with no effort tiers: the host takes
  // `Object.keys(variants)` verbatim, so a placeholder would surface as a
  // fake "none" reasoning variant in the picker.
  return {
    name: row.label || row.id,
    limit: { ...LIMIT_DEFAULT },
    variants,
    capabilities: {
      reasoning: (row.efforts?.length ?? 0) > 0,
      input: { text: true, image: false },
      output: { text: true },
    },
  };
}

function listFromRows(rows) {
  const out = {};
  for (const row of rows) out[row.id] = modelEntry(row);
  return out;
}

/**
 * The shipped snapshot, marked as a fallback.
 *
 * magpie decides "this list is a fallback" from the returned object, not from
 * a flag beside it: `out.fellBack` is true only when the hook handed back the
 * very object it was given, or one carrying `Symbol.for("magpie.fellBack")`.
 * A fresh plain object therefore reads as the account's real catalog, so the
 * editor advertises these models and every turn 502s against a vendor that
 * never listed them. Non-enumerable so `Object.entries(next)` in the host
 * doesn't turn the marker into a model.
 */
const FELL_BACK = Symbol.for("magpie.fellBack");
function fallbackList() {
  const list = listFromRows(FALLBACK_MODELS);
  Object.defineProperty(list, FELL_BACK, { value: true, enumerable: false });
  return list;
}

/** Normalize the vendor catalog payload into our row shape. */
function rowsFromPayload(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models
    .filter((m) => m && typeof m.id === "string" && m.id)
    .map((m) => ({
      id: m.id,
      label: m.displayName || m.name || m.id,
      provider: m.provider || "",
      cost: Number.isFinite(m.costMultiplier) ? m.costMultiplier : undefined,
      // The vendor drops a single-effort list to empty (a one-item enum is
      // the same as no choice), so mirror that: only >1 counts as variants.
      efforts: Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 1 ? m.reasoningEfforts : [],
    }));
}

async function loadCatalog(auth, s, client, { force = false } = {}) {
  if (s.catalogPromise) return s.catalogPromise;

  const now = Date.now();

  // A failed fetch backs off whether or not a catalog is cached. This used
  // to live in an `else if` hanging off `if (s.catalog)`, so it only ran
  // when there was no catalog at all — and the case that actually hammers
  // the vendor is a *stale* catalog with the vendor down. There `fresh` is
  // false, the branch was skipped, and every chat turn fired one GET
  // /api/models for as long as the outage lasted, with the 6h TTL never
  // engaging. `force` deliberately does not override this: there is
  // nothing to force.
  if (now - s.catalogFailedAt < CATALOG_FAIL_TTL_MS) return s.catalog;

  if (s.catalog && now - s.catalogAt < CATALOG_TTL_MS && !force) return s.catalog;

  s.catalogPromise = (async () => {
    try {
      const payload = await client.models();
      const rows = rowsFromPayload(payload);
      if (rows.length) {
        s.catalog = { rows, models: rows.map((r) => ({ id: r.id })), fetchedAt: Date.now() };
        s.catalogAt = Date.now();
        s.catalogFailedAt = 0;
      } else {
        // Reachable but empty: a real answer, just not a usable one yet.
        s.catalogFailedAt = Date.now();
      }
      return s.catalog;
    } catch (e) {
      // An expired session is not a catalog outage. Swallowing it here made
      // the `signIn: "expired"` branch in `provider.models` unreachable —
      // magpie documents that throw as the way a model list marks an
      // account dead, so let it through.
      if (e instanceof AuthExpiredError) throw e;
      s.catalogFailedAt = Date.now();
      return s.catalog; // keep whatever we had; never break a request over the catalog
    } finally {
      s.catalogPromise = null;
    }
  })();

  return s.catalogPromise;
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * `init.body` is documented as a JSON string, or bytes when the payload is
 * not UTF-8 (HOOKS.md:525). `String(bytes)` yields `"123,34,107"` — a
 * string, so the try/catch around JSON.parse never sees a type error and
 * every turn is rejected as malformed JSON. Decode before parsing.
 */
function decodeRequestBody(body) {
  if (body == null) return "{}";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return String(body);
}

export const DongleyaAuthPlugin = async (input = {}, options = {}) => {
  const log = (level, msg) => {
    if (options?.debug) console.log(`[dongleya] ${level}: ${msg}`);
  };
  // `origin` is only ever overridden by the test harness; production always
  // talks to the real site.
  const origin = options?.origin || BASE;
  const shared = new DongleyaClient({ onLog: log, origin });

  /**
   * Read a plugin option as it stands *now*.
   *
   * Called, not read once: magpie re-reads options on every provider build
   * without restarting the host, so a cached boolean would keep a toggled
   * switch stale until reload. Absent host support reads as `false`, which is
   * the default for every option we declare.
   */
  const optionOn = (key) => input?.magpie?.option?.(PROVIDER, key) === true;

  /** Validate a token against /api/auth/me; throws AuthExpiredError when dead. */
  async function verifyToken(token) {
    return shared.me(token);
  }

  /** Identity read used to name the account card. */
  /**
   * Open the invite gate for a freshly signed-in account, then publish that
   * account's own code so the next login can use it.
   *
   * 懂了鸭 hands out accounts to anyone with a phone number and only checks
   * the invite at the gate. So a successful login proves nothing, and the
   * plugin has to walk the gate itself — otherwise the user signs in, sees a
   * green account card, and every turn 403s.
   *
   * Never throws into the login path: if the gate will not open (no code
   * left, vendor changed the endpoint), the account is still real and still
   * worth saving. `usage` shows the gate state, and re-login retries it.
   *
   * Returns `{ granted, code, note }` for logging and for tests.
   */
  async function settleAccess(auth, token) {
    const c = new DongleyaClient({ token, onLog: log, origin });
    let me = null;
    try {
      me = await c.me(token);
    } catch (e) {
      if (e instanceof AuthExpiredError) throw e;
      return { granted: false, code: "", note: `me 查询失败: ${e?.message ?? e}` };
    }
    const access = accessOf(me);
    if (access.granted) {
      // Already in — this account's code sponsors the next one.
      return { granted: true, code: await publishOwnCode(c, token, auth), note: "" };
    }

    const fixed = optionOn("invite_fixed");
    const candidate = fixed ? readInvite() || AUTHOR_INVITE : nextInvite();
    if (!candidate) return { granted: false, code: "", note: "没有可用的邀请码" };

    try {
      await c.redeemInvite(token, candidate);
    } catch (e) {
      if (e instanceof AuthExpiredError) throw e;
      // A rejected code is the interesting case: the rolled code went stale
      // (its owner was deleted, or a `fixed` code ran out). Drop it so the
      // next attempt falls back to the author's instead of retrying a dead
      // one forever.
      if (e instanceof InviteInvalidError) {
        // Pass the candidate so a concurrent login that already rolled the
        // pointer to a fresh good code doesn't get erased.
        if (candidate !== AUTHOR_INVITE) clearInvite(candidate);
        return { granted: false, code: candidate, note: `邀请码 ${candidate} 无效` };
      }
      return { granted: false, code: candidate, note: `兑换失败: ${e?.message ?? e}` };
    }

    // Re-read rather than trusting the redeem response: the gate state lives
    // on /me, and a 200 on redeem is not the same claim as accessGranted.
    try {
      const after = accessOf(await c.me(token));
      if (!after.granted) return { granted: false, code: candidate, note: "兑换后仍未获准入" };
    } catch {
      /* treat an unreadable /me as "do not publish a code" */
      return { granted: false, code: candidate, note: "兑换后无法确认准入状态" };
    }
    // Gate is open — hand this account's *own* code to the next login, not
    // the one it just spent.
    return { granted: true, code: await publishOwnCode(c, token, auth), note: "" };
  }

  /** Record this account's own referral code so the next login can redeem it. */
  async function publishOwnCode(c, token, auth) {
    try {
      const r = await c.referralMe(token);
      const code = normaliseCode(r?.data?.code ?? r?.code);
      if (!code) return "";
      const id = auth?.accountId || auth?.userId || auth?.phone || "";
      // Per-account memory is always kept: it is a record of which code came
      // from whom, useful even when the rolling pointer is pinned.
      noteAccountCode(id, code, auth?.label);
      // `invite_fixed` pins the code the next login uses; rolling off it would
      // be the exact thing the switch exists to prevent.
      if (!optionOn("invite_fixed")) writeInvite(code, { from: auth?.label || id });
      return code;
    } catch {
      return "";
    }
  }

  /** Shape a /api/auth/me payload into the account fields magpie wants. */
  function identityFromMe(me, fallback) {
    const u = me?.user ?? me?.data?.user ?? me?.data ?? me ?? {};
    const id = String(u.userId ?? u.id ?? u.uid ?? "");
    const phone = u.phone || u.mobile || "";
    const nick = u.nickname || u.nickName || u.displayName || "";
    return {
      userId: id || fallback?.userId || "",
      phone: phone || fallback?.phone || "",
      label: nick || maskPhone(phone) || fallback?.label || "",
    };
  }

  async function identityOf(token, fallback) {
    try {
      return identityFromMe(await verifyToken(token), fallback);
    } catch (e) {
      if (e instanceof AuthExpiredError) throw e;
      return { ...(fallback ?? {}) };
    }
  }

  return {
    // ---- provider declaration ----
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "懂了鸭 Dongleya",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        models: listFromRows(FALLBACK_MODELS),
      };
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 3,
      refreshLead: REFRESH_LEAD_MS,

      // The vendor's editor shows these as Plugin options (bools only).
      options: [
        {
          // The host validates option keys against /^[a-z0-9_-]{1,40}$/ and
          // silently drops any that fail, so a camelCase key is a switch that
          // never renders and an optionOn() that is permanently false.
          key: "invite_fixed",
          label: "邀请码固定不滚动",
          description:
            "开：新号固定用当前邀请码，不跟随登录变化。关（默认）：跟随最后一个登录成功的账号——它的邀请码会成为下一个号的码。",
          default: false,
        },
      ],

      methods: [
        // ---- 1. SMS code login (the vendor's own route) ----
        {
          type: "oauth",
          label: "短信验证码登录 / SMS code",
          prompts: [{ type: "text", key: "phone", message: "手机号 / Phone (11 digits)", placeholder: "1xxxxxxxxxx" }],
          async authorize(inputs) {
            if (!inputs?.phone || !String(inputs.phone).trim()) {
              throw new Error("需要填写手机号 / phone number is required");
            }
            const phone = String(inputs.phone).trim();
            if (!/^1\d{10}$/.test(phone)) {
              throw new Error("手机号格式不对 / phone must be 11 digits starting with 1");
            }
            try {
              await shared.sendVerifyCode(phone);
            } catch (e) {
              // The vendor answers HTTP 200 + INVALID_INPUT for a number it
              // will not text, and puts the actual cause in `reason`
              // (e.g. official_code_required). Surface it — a bare
              // "failed to send code" tells the user nothing.
              if (e instanceof InvalidInputError) {
                throw new Error(
                  e.reason === "official_code_required"
                    ? "懂了鸭要求先通过官方渠道验证这个手机号，请先在网页端登录一次再回来。\n" +
                      "The vendor wants this number verified on the site first — sign in at dongleya.qq.com once, then retry."
                    : `验证码发送被拒 / code request rejected: ${e.reason ?? e.message}`,
                );
              }
              throw new Error(`验证码发送失败 / failed to send code: ${e?.message ?? e}`);
            }
            return {
              instructions:
                `验证码已发送到 ${maskPhone(phone)}，请查收短信并输入 6 位验证码。\n` +
                `A code was sent to ${maskPhone(phone)} — enter the 6 digits.`,
              method: "code",
              async callback(code) {
                const c = String(code ?? "").trim();
                if (!c) return { type: "failed", error: "请输入收到的验证码" };
                try {
                  const r = await shared.verifyCode(phone, c);
                  const token = r?.token || r?.data?.token || r?.data?.accessToken;
                  if (!token) return { type: "failed", error: "登录响应里没有 token" };
                  const who = await identityOf(token, { phone, label: maskPhone(phone) });
                  const auth = authWithSession(null, { token, phone, ...who });
                  // Redeem an invite before magpie can report a signed-in
                  // account: being signed in is not being let in.
                  const gate = await settleAccess(auth, token);
                  if (gate.note) log("warn", `dongleya: 准入 ${gate.note}`);
                  // Warm the catalog so magpie shows the real models right away.
                  try {
                    await loadCatalog(auth, acctState(auth), shared, { force: true });
                  } catch {
                    /* non-blocking */
                  }
                  return auth;
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e).slice(0, 300) };
                }
              },
            };
          },
        },

        // ---- 2. paste the browser's eureka_token (fallback) ----
        {
          type: "api",
          label: "粘贴浏览器 Token / Paste eureka_token",
          // Magpie only hands `inputs` to a method that declares prompts
          // (HOOKS.md 陷阱 2) — a prompts-less api method is called with
          // `undefined` and this authorize would have nothing to read.
          placeholder: "eyJhbGciOi...",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "eureka_token（浏览器 Console 里运行 copy(localStorage.eureka_token)）",
              placeholder: "eyJhbGciOi...",
            },
          ],
          async authorize(inputs) {
            const raw = String(inputs?.key ?? inputs?.token ?? inputs?.apiKey ?? "").trim();
            if (!raw) throw new Error("需要粘贴 eureka_token");
            const token = raw.replace(/^Bearer\s+/i, "").trim();
            if (token.split(".").length !== 3) {
              throw new Error("这不像一个 JWT。请在 dongleya.qq.com 登录后运行 copy(localStorage.eureka_token) 再粘贴。");
            }
            // One /me, not two: `identityOf` reads the same endpoint for the
            // same token, so validating separately doubled the round trips
            // on every paste.
            let me;
            try {
              me = await verifyToken(token);
            } catch (e) {
              if (e instanceof AuthExpiredError) throw new Error("这个 token 已失效，请重新获取");
              throw new Error(`token 校验失败: ${e?.message ?? e}`);
            }
            const who = identityFromMe(me);
            const auth = authWithSession(null, { token, ...who });
            const gate = await settleAccess(auth, token);
            if (gate.note) log("warn", `dongleya: 准入 ${gate.note}`);
            try {
              await loadCatalog(auth, acctState(auth), shared, { force: true });
            } catch {
              /* non-blocking */
            }
            return { type: "success", ...auth };
          },
        },
      ],

      // ---- renewal: the JWT has no refresh token, so this only re-verifies
      // and drops the account when the token is actually dead. ----
      // `expires: 0` on a pass is deliberate, not lazy: magpie schedules the
      // next renewal at `expires − refreshLead`, and a pass hands back the
      // same JWT `expires` — there is nothing to extend. That left
      // `renewAt` in the past for the whole lead window, so every request,
      // models listing, usage and checkin fired a /me probe, an auth-file
      // lock and a write. After one pass the token cannot get fresher, and
      // a token that dies early is marked by the loader's 401
      // (`signIn: "expired"`), which is the safety net that matters.
      async refresh(auth) {
        const session = sessionOf(auth);
        if (!session) return;
        const exp = jwtExpiry(session.token);
        if (exp && exp - Date.now() > REFRESH_LEAD_MS) {
          return { expires: exp }; // not due yet: keep the bookkeeping honest
        }
        await verifyToken(session.token); // throws AuthExpiredError when dead
        // Probed once, alive: nothing to renew until the user signs in again.
        return { expires: 0 };
      },

      // ---- request takeover ----
      async loader(getAuth) {
        const auth = await getAuth();
        const session = sessionOf(auth);
        if (!session) return {};

        const s = acctState(auth);
        const c = new DongleyaClient({ token: session.token, onLog: log, origin });

        // Keep the catalog warm in the background; never block the request.
        loadCatalog(auth, s, c).catch(() => {});

        return {
          baseURL: BASE,
          // magpie only ever sends POST {baseURL}/chat/completions into this
          // fetch (the loader npm is @ai-sdk/openai-compatible); the model
          // list comes from provider.models and /v1/models is answered by
          // magpie's own gateway. The plugin opens no ports.
          async fetch(input, init) {
            let body;
            try {
              body = JSON.parse(decodeRequestBody(init?.body));
            } catch {
              return openaiError(400, "request body is not valid JSON", "invalid_request_error");
            }

            try {
              return await handleChatCompletion(c, session, s, body, { signal: init?.signal });
            } catch (err) {
              if (err instanceof GatewayError) return err.toResponse();
              if (err instanceof AuthExpiredError) {
                // magpie's contract: an error carrying signIn:"expired" marks
                // the account dead and offers a re-sign-in.
                throw Object.assign(new Error(`懂了鸭拒绝了这个会话，请重新登录 (${err.message})`), {
                  signIn: "expired",
                });
              }
              const status = errorStatus(err);
              // The envelope's `code` is the upstream code name when we have
              // one, not the HTTP status — `openaiError` otherwise repeats
              // the status in both fields, so `code: 502` says nothing about
              // what happened.
              const codeName = err?.codeName ?? err?.code ?? status;
              // The vendor's backoff guidance dies here otherwise: it is a
              // header on their 429, and without forwarding it every client
              // and every retry loop guesses its own pace.
              const retryAfter = err?.retryAfterSec;
              const headers =
                Number.isFinite(retryAfter) && retryAfter > 0
                  ? { "retry-after": String(Math.ceil(retryAfter)) }
                  : {};
              return openaiError(status, err?.message ?? String(err), "upstream_error", codeName, headers);
            }
          },
        };
      },

      // ---- quota ----
      async usage(getAuth) {
        const auth = await getAuth();
        const session = sessionOf(auth);
        if (!session) return { error: "未登录", windows: [] };

        const c = new DongleyaClient({ token: session.token, onLog: log, origin });
        try {
          // The credit balance says nothing about whether the account may
          // actually chat — a freshly registered account has credits and is
          // still gated by the invite system. Ask both, so the card can say
          // "pending approval" instead of showing a healthy balance next to a
          // provider that 403s on every turn.
          const [payload, mePayload] = await Promise.all([
            c.credits(session.token),
            c.me(session.token).catch(() => null),
          ]);
          const access = mePayload ? accessOf(mePayload) : { granted: true };
          const d = payload?.data ?? payload ?? {};

          // `Number.isFinite` rejects a numeric string, and the fallback was
          // `0` — so a vendor that ever switches to `"489.69"` would silently
          // render a spent account. Coerce first, and keep `null` meaning
          // "not said" so the card shows a dash rather than a spendable zero.
          const num = (v) => {
            if (v === null || v === undefined || v === "") return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };
          const round2 = (n) => Math.round(n * 100) / 100;
          const money = (n) => `${round2(n)} 积分`;

          const balance = num(d.balance);
          const gifted = num(d.totalGifted);
          const spent = num(d.totalUsed);
          const eggs = num(d.eggs?.balance) ?? num(d.eggBalance);
          const downloads = num(d.downloadQuota?.available);
          const tier = d.hasActiveMembership ? d.membershipTier || "会员" : "免费";

          const windows = [];

          // One quantity, one row. `balance` is the aggregate of the credit
          // buckets and the ledger only ever has one (`creation_credits`), so
          // `creationCredits.available` is the same number under a second
          // name — rendering both showed 489.69 twice, as two wallets.
          //
          // No `used` here on purpose: magpie reads it as a percentage of a
          // cap, and `used: 0` is a real "0% consumed", not "unknown". A
          // prepaid wallet is expressed with `balance` + `unit` (the host
          // ranks accounts by it), and leaving `used` off is what means
          // "not said". `aside` is also wrong on a prepaid balance: running
          // out does stop the account.
          if (balance !== null) {
            windows.push({
              name: "积分余额",
              balance: round2(balance),
              unit: "积分",
              display: money(balance),
            });
          }
          // The vendor does publish a ceiling — totalGifted is what was ever
          // granted. Surfacing it turns "489.69" into "489.69 / 500".
          //
          // `display` only, no `amount`/`limit`: those two make magpie
          // derive `used = amount / limit * 100` and treat the row as a
          // measured window. This one is a lifetime cumulative pair — it
          // never resets, so the curve it drew climbed to 100% and stayed
          // there, and the card showed a progress track for a total that
          // isn't an allowance. As text it is what it says it is.
          if (gifted !== null && spent !== null) {
            windows.push({
              name: "累计消耗",
              display: `${round2(spent)} / ${round2(gifted)} 积分`,
              aside: true,
            });
          }
          if (eggs !== null && eggs > 0) {
            windows.push({ name: "鸭蛋", balance: round2(eggs), unit: "鸭蛋", display: `${round2(eggs)} 鸭蛋`, aside: true });
          }
          if (downloads !== null) {
            windows.push({ name: "下载额度", balance: round2(downloads), unit: "次", display: `${round2(downloads)} 次`, aside: true });
          }
          // The creation-credit and download expiries are the same instant;
          // one row covers both.
          const expiresAt = d.creationCredits?.expiresAt ?? d.downloadQuota?.expiresAt;
          if (expiresAt) {
            windows.push({
              name: "有效期",
              display: new Date(expiresAt).toLocaleDateString("zh-CN"),
              aside: true,
            });
          }
          // Lead with the gate when it is closed: it is the only thing that
          // explains why every turn fails, and it is not a balance problem.
          if (!access.granted) {
            windows.unshift({
              name: "准入状态",
              display:
                access.application === "pending"
                  ? "待审批 · 申请已提交"
                  : access.application === "rejected"
                    ? "未通过 · 需要邀请码"
                    : "未获准入 · 需要邀请码",
              aside: true,
            });
          }

          return {
            plan: `懂了鸭 Dongleya · ${tier}`,
            user: auth?.label || auth?.phone || auth?.userId || undefined,
            // `text()` blanks a number, so this stays a string.
            balance: balance === null ? "" : money(balance),
            windows,
          };
        } catch (e) {
          if (e instanceof AuthExpiredError) {
            state.delete(scopeKey(auth));
            return { error: "登录已过期，请重新登录", windows: [], signIn: "expired" };
          }
          return { error: String(e?.message ?? e).slice(0, 200), windows: [] };
        }
      },

      // ---- daily checkin ----
      // Contract: { outcome, credit?, streak?, message? }. The vendor has no
      // status endpoint — the only way to know is to POST and read
      // `alreadyCheckedIn`, which is exactly what the outcome field encodes.
      async checkin(getAuth) {
        const auth = await getAuth();
        const session = sessionOf(auth);
        if (!session) return { outcome: "failed", message: "未登录" };

        const c = new DongleyaClient({ token: session.token, onLog: log, origin });
        try {
          const payload = await c.checkin(session.token);
          const d = payload?.data ?? payload ?? {};
          if (d.alreadyCheckedIn === true) {
            return {
              outcome: "done",
              credit: Number.isFinite(d.credits) ? d.credits : undefined,
              message: "今天已签到",
            };
          }
          const credit =
            (Number.isFinite(d.credits) ? d.credits : 0) +
            (Number.isFinite(d.creationCredits) ? d.creationCredits : 0);
          if (d.alreadyCheckedIn === false && credit > 0) {
            return { outcome: "claimed", credit, message: `签到成功，获得 ${credit} 积分` };
          }
          if (d.alreadyCheckedIn === false) {
            return { outcome: "done", message: "今天已签到" };
          }
          return { outcome: "inactive", message: "当前没有可参加的签到活动" };
        } catch (e) {
          if (e instanceof AuthExpiredError) return { outcome: "failed", message: "登录已过期" };
          return { outcome: "failed", message: String(e?.message ?? e).slice(0, 200) };
        }
      },
    },

    // ---- per-account model catalog ----
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const session = sessionOf(auth);
        if (!session) return fallbackList();
        const s = acctState(auth);
        try {
          const c = new DongleyaClient({ token: session.token, onLog: log, origin });
          const catalog = await loadCatalog(auth, s, c, { force: !s.catalog });
          if (catalog?.rows?.length) return listFromRows(catalog.rows);
          return fallbackList();
        } catch (e) {
          if (e instanceof AuthExpiredError) {
            state.delete(scopeKey(auth));
            throw Object.assign(new Error("懂了鸭会话已过期，请重新登录"), { signIn: "expired" });
          }
          return fallbackList();
        }
      },
    },

    // ---- per-request headers ----
    // The host runs every plugin's chat.headers against every outgoing
    // request — the filter is "declares the hook", not "is this provider's
    // turn" — so without this guard the header lands on requests to
    // Anthropic, OpenAI and everyone else. That hands magpie's session id to
    // third parties, and vendors that reject unknown headers 400 on it.
    "chat.headers": async (input, output) => {
      if (input?.provider?.info?.id !== PROVIDER) return;
      if (input?.sessionID) output.headers["x-session-id"] = String(input.sessionID);
    },
  };
};

export default DongleyaAuthPlugin;

/** Test surface. magpie calls every exported *function* as a plugin, so
 *  this is an object on purpose: nothing here is registered or invoked.
 *  (See docs/zh/plugins § 模块导出什么.) */
export const _internal = { loadCatalog, scopeKey };
