// src/dongleya.mjs — 懂了鸭 (dongleya.qq.com / eureka2) upstream client.
//
// Everything the plugin knows about the vendor lives here: the request
// envelope (browser UA is mandatory — without it the edge answers 403
// "Invalid client" instead of 401), SMS login, the JWT session, the
// `/api/v3/chat` `data: `-framed event stream, credits, and the model
// catalog. Nothing in this file knows about OpenAI or magpie.
//
// Verified against the vendor's production bundles, which are kept locally
// and not shipped (dly-ttb.js §authFetch, dly-index.js §smsAuth,
// dly-chat.js §engine).

const ORIGIN = "https://dongleya.qq.com";

// The edge validates the UA before it validates the token. A bare `curl/x.y`
// gets 403 {codeName:"Invalid client"}; any browser-shaped UA gets 401. Every
// request below carries this, including unauthenticated login calls.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** Upstream said the session is dead (401). magpie maps this to signIn:"expired". */
export class AuthExpiredError extends Error {
  constructor(message = "懂了鸭会话已失效，请重新登录") {
    super(message);
    this.name = "AuthExpiredError";
    // The host marks the account by this field, not by the class: a refresh
    // that throws without `signIn: "expired"` is read as a transient fault
    // and retried every RENEW_RETRY forever, against a token the vendor has
    // already revoked.
    this.signIn = "expired";
  }
}

/** 429 from the edge. `retryAfterSec` is frequently undefined upstream (the
 *  client Number()s a missing header) — callers must default it. */
export class RateLimitedError extends Error {
  constructor(message, { retryAfterSec, code, details } = {}) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterSec = retryAfterSec;
    this.code = code;
    this.details = details;
  }
}

/** Logged in, but the account has not been granted access (invite gate).
 *  Distinct from auth expiry: re-login does not fix it.
 *
 *  Verified live — `/api/auth/me` answers `success:true` with
 *  `{inviteOnly:true, accessGranted:false, onboardingCompleted:false}` for a
 *  freshly registered account, and the first chat turn then fails
 *  `INVITE_REQUIRED`. So a "successful login" is not proof of access, and the
 *  message has to say what the human actually has to do about it. */
export class InviteRequiredError extends Error {
  constructor(message = inviteMessage()) {
    super(message);
    this.name = "InviteRequiredError";
  }
}

/**
 * Turn the vendor's bare `INVITE_REQUIRED` into something a human can act on.
 *
 * Being signed in is not the same as being let in: the gate is
 * `inviteOnly && !accessGranted`, and re-logging in changes neither. Say how
 * to get in, because "INVITE_REQUIRED" reads like a plugin bug.
 */
export function inviteMessage(upstream) {
  const detail = String(upstream ?? "").trim();
  return (
    "懂了鸭该账号尚未获得准入（邀请制）。登录是成功的，但需要邀请码或被审批后才能对话。" +
    "可在 dongleya.qq.com 提交准入申请，或兑换邀请码。" +
    (detail && detail !== "INVITE_REQUIRED" ? ` [${detail}]` : "")
  );
}

/**
 * Read the invite gate out of an `/api/auth/me` payload.
 *
 *   { granted: true }                          → normal account
 *   { granted: false, application: "pending" } → applied, waiting
 *   { granted: false, application: null }      → never applied
 *
 * `null` means "the vendor did not say", which is not the same as denied —
 * a missing field must not be reported to the user as a rejection.
 */
export function accessOf(me) {
  const d = me?.data ?? me ?? {};
  if (d.accessGranted !== false) return { granted: true };
  return {
    granted: false,
    inviteOnly: d.inviteOnly === true,
    application: d.application?.status ?? null,
    onboardingCompleted: d.onboardingCompleted === true,
  };
}

/** A specific invite code was rejected by the gate. Not a credential problem
 *  and not a transient fault: the code itself is wrong or out of codes. The
 *  login path catches this to fall back rather than to fail the sign-in. */
export class InviteInvalidError extends Error {
  constructor(message = "邀请码无效") {
    super(message);
    this.name = "InviteInvalidError";
  }
}

export class ModelNotFoundError extends Error {
  constructor(requested, available) {
    super(`懂了鸭没有模型 "${requested}"`);
    this.name = "ModelNotFoundError";
    this.requested = requested;
    this.available = available;
  }
}

/** Content moderation stopped the generation. Not retryable. */
export class ContentFilterError extends Error {
  constructor(message = "内容被懂了鸭安全策略拦截") {
    super(message);
    this.name = "ContentFilterError";
  }
}

/** Ran out of credits mid-generation. Not retryable. */
export class InsufficientCreditsError extends Error {
  constructor(message = "懂了鸭积分不足") {
    super(message);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * The edge rejected our client fingerprint rather than our credential.
 * Verified live: `/api/v3/chat` with a non-browser UA answers HTTP 403
 * `{code:20003, codeName:"FORBIDDEN", message:"Invalid client"}` no matter
 * how valid the token is. This is a plugin-is-stale condition — retrying the
 * account cannot fix it — so it must not be reported as an auth or user error.
 */
export class ClientRejectedError extends Error {
  constructor(message = "懂了鸭边缘节点拒绝了客户端指纹（UA 需更新）") {
    super(message);
    this.name = "ClientRejectedError";
  }
}

/** Anything else the upstream reported as a business error. */
export class UpstreamError extends Error {
  constructor(message, { status = 502, code, codeName } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.codeName = codeName;
  }
}

/**
 * The caller's own input was rejected (bad phone number, captcha required,
 * malformed field). Verified live: `POST /api/auth/sms/send-code` answers
 * HTTP **200** with `{code:10001, codeName:"INVALID_INPUT",
 * reason:"official_code_required"}` — so this must never be mistaken for an
 * upstream outage, and `reason` is the part a human can act on.
 */
export class InvalidInputError extends Error {
  constructor(message = "请求参数不合法", { reason, code, codeName } = {}) {
    super(message);
    this.name = "InvalidInputError";
    this.reason = reason;
    this.code = code;
    this.codeName = codeName;
  }
}

/** The stream carried a frame we could not parse or an in-band error event. */
export class StreamFrameError extends Error {
  constructor(message, { kind = "unknown", code } = {}) {
    super(message);
    this.name = "StreamFrameError";
    this.kind = kind;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// envelope helpers
// ---------------------------------------------------------------------------

/** Headers every same-origin API call carries. */
function baseHeaders(origin = ORIGIN) {
  return {
    "user-agent": BROWSER_UA,
    origin,
    referer: `${origin}/chat`,
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** The vendor wraps errors as {code, codeName, message} with a numeric `code`
 *  (0 = success) and an HTTP status that does NOT always agree with it: a
 *  business failure frequently arrives as HTTP 200 + code!==0, which the web
 *  client rewrites into a synthetic 400 before it reaches application code.
 *  So: trust the body, not only the status. */
function isBusinessFailure(status, body) {
  if (!status || status >= 400) return true;
  if (!body || typeof body !== "object") return false;
  return (typeof body.code === "number" && body.code !== 0) || body.success === false;
}

function bodyMessage(body, fallback) {
  return (
    body?.error?.message ||
    body?.message ||
    body?.error?.codeName ||
    body?.codeName ||
    fallback
  );
}

function bodyCodeName(body) {
  return body?.error?.codeName || body?.codeName || body?.error?.code || body?.code;
}

/**
 * `retry-after` as whole seconds, or `undefined` when the vendor said nothing.
 *
 * The naive `Number(res.headers.get(...))` is a trap: `get` returns `null`
 * when the header is absent, `Number(null)` is `0`, and `Number.isFinite(0)`
 * is `true` — so the "absent" branch never fires and every 429 carries
 * `retryAfterSec: 0`. magpie backs off zero seconds, re-fires into the limit
 * and repeats, which is how a rate-limit blip becomes a ban.
 *
 * The header is either delta-seconds or an HTTP date; handle both, and treat
 * "now or in the past" as no opinion rather than as zero.
 */
function retryAfterOf(res) {
  const raw = res.headers.get("retry-after");
  if (raw === null || raw === "") return undefined;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds)) return asSeconds > 0 ? asSeconds : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const secs = Math.ceil((at - Date.now()) / 1000);
  return secs > 0 ? secs : undefined;
}

/** Map an upstream body onto the right error class. */
function classify(status, body, fallbackMessage) {
  const codeName = String(bodyCodeName(body) ?? "");
  const message = bodyMessage(body, fallbackMessage);

  if (status === 401 || codeName === "UNAUTHORIZED" || codeName === "INVALID_TOKEN") {
    return new AuthExpiredError(message);
  }
  // `FORBIDDEN` + "Invalid client" is the UA gate, not a permissions problem.
  // Anything else FORBIDDEN still means "this account may not do that".
  if (codeName === "FORBIDDEN" && /invalid client/i.test(message)) {
    return new ClientRejectedError(message);
  }
  if (codeName === "INVALID_INPUT" || codeName === "INVALID_PARAMS" || codeName === "BAD_REQUEST") {
    return new InvalidInputError(message, {
      reason: body?.reason,
      code: body?.code,
      codeName,
    });
  }
  if (codeName === "INVITE_REQUIRED") return new InviteRequiredError(inviteMessage(message));
  if (codeName === "INVITE_INVALID") return new InviteInvalidError(message);
  if (codeName === "INSUFFICIENT_CREDITS") return new InsufficientCreditsError(message);
  if (codeName === "CONTENT_FILTER" || codeName === "HTML_MODERATION_REJECTED") {
    return new ContentFilterError(message);
  }
  if (codeName === "MODEL_BUSY" || codeName === "GENERATION_IN_PROGRESS") {
    return new StreamFrameError(message, { kind: "busy", code: codeName });
  }
  if (codeName === "MODEL_FAILED" || codeName === "MODEL_REJECTED" || codeName === "MODEL_STALLED") {
    return new StreamFrameError(message, { kind: "model-rejected", code: codeName });
  }
  if (codeName === "CONTEXT_TOO_LONG") {
    return new UpstreamError(message, { status: 400, codeName });
  }
  return new UpstreamError(message, {
    status: status && status >= 400 ? status : 502,
    code: body?.code,
    codeName,
  });
}

// ---------------------------------------------------------------------------
// stream framing
// ---------------------------------------------------------------------------

/**
 * Parse the vendor's event framing: blocks separated by a blank line, where a
 * block holds one or more `data: {json}` lines (the parser takes the first).
 * Not standard SSE — no `event:`/`id:` lines, and the content type is not
 * always `text/event-stream`.
 *
 * Yields parsed objects; unparseable blocks are skipped (the web client only
 * console.warns them, so a malformed frame must never kill the generation).
 *
 * `onFrame` fires for every block, parsed or not. The idle watchdog needs it:
 * a heartbeat or comment block parses to `null` and so never reaches the
 * `yield`, and a watchdog re-armed only per yielded event would kill a
 * perfectly healthy stream that is sending keep-alives and nothing else.
 */
export async function* parseEventStream(body, onFrame) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // The separator is a blank line, which on a CRLF stream is `\r\n\r\n` —
      // that contains no `\n\n`, so a plain indexOf("\n\n") would never split
      // it and the whole response would sit in the buffer until EOF.
      let m;
      while ((m = FRAME_SEP.exec(buf)) !== null) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        onFrame?.();
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    // Flush a trailing block that arrived without a closing separator.
    const tail = parseBlock(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

const FRAME_SEP = /\r?\n\r?\n/;

/** Pull the first `data: ` line out of one frame block and parse it. */
function parseBlock(block) {
  if (!block) return null;
  for (const line of block.split("\n")) {
    const l = line.replace(/\r$/, "");
    if (!l.startsWith("data: ")) continue;
    const raw = l.slice(6).trim();
    if (!raw || raw === "[DONE]") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null; // malformed frame: skip, exactly like the vendor's own client
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

// The vendor publishes no ceiling to copy here. The only named timeouts in
// its bundles are 30s for its self-update script and 5s for a preview's
// first frame; neither is the chat stream, and a reasoning model's
// first token routinely outlives both anyway. So these two are the
// plugin's own judgement, and they exist because magpie imposes nothing in
// this direction: for `fetch` the host contract is `init.signal` alone
// ("在 agent 放弃请求时中止") and the body is relayed chunk by chunk with
// no deadline anywhere in internal/plugin/host.js. Without a watchdog a
// half-open edge pins the request, the client and the socket until the
// agent gives up — which, for an agent with no turn timeout, is never.
const FIRST_BYTE_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 60_000;
/** Ceiling for a whole non-streaming call, headers and body together. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * One account's view of the vendor.
 *
 * The three timeouts are overridable so tests can drive them in
 * milliseconds instead of sleeping for a minute.
 *
 * @param {{ token?: string, firstByteTimeoutMs?: number,
 *           idleTimeoutMs?: number, fetchTimeoutMs?: number }} opts
 *   `token` is the `eureka_token` JWT.
 */
export class DongleyaClient {
  constructor(opts = {}) {
    this.token = opts.token ?? "";
    this.origin = opts.origin ?? ORIGIN;
    this.onLog = opts.onLog ?? (() => {});
    this.firstByteTimeoutMs = opts.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  // ---- low level ---------------------------------------------------------

  async #fetch(path, { method = "GET", json, token, signal, extraHeaders } = {}) {
    const headers = { ...baseHeaders(this.origin), ...(extraHeaders ?? {}) };
    if (json !== undefined) headers["content-type"] = "application/json";
    Object.assign(headers, authHeaders(token ?? this.token));

    // Every non-chat call goes through here with no signal, so a stalled
    // edge (TCP up, no bytes) pinned the promise — and the client, the
    // session closure and the socket — for as long as the stall lasted. The
    // chat path has its own first-byte timeout; everything else gets this.
    // `AbortSignal.timeout` self-cleans, so there is no timer to clear.
    // `AbortSignal.any` composes rather than replaces: a caller's signal used
    // to short-circuit the deadline entirely, so the one non-chat path that
    // does pass one silently lost its 30s cap.
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.fetchTimeoutMs)])
      : AbortSignal.timeout(this.fetchTimeoutMs);

    let res;
    try {
      res = await fetch(`${this.origin}${path}`, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: deadline,
        // The bearer token rides in a header, and `follow` would carry it to
        // wherever the redirect points. The vendor has no legitimate reason
        // to redirect an API call, so a 3xx is a security event, not a
        // routing detail: refuse it rather than hand the credential over.
        redirect: "manual",
      });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      if (e?.name === "TimeoutError")
        throw new UpstreamError(`懂了鸭请求超时: ${path}`, { status: 504 });
      throw new UpstreamError(`懂了鸭网络错误: ${e?.message ?? e}`, { status: 502 });
    }

    if (res.status >= 300 && res.status < 400) {
      // Drain so the socket is not left half-read; the body is meaningless.
      await res.text().catch(() => {});
      throw new UpstreamError(`懂了鸭接口返回重定向（${res.status}），已拒绝跟随`, {
        status: 502,
      });
    }

    let text;
    try {
      text = await res.text();
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      if (e?.name === "TimeoutError")
        throw new UpstreamError(`懂了鸭响应超时: ${path}`, { status: 504 });
      throw new UpstreamError(`懂了鸭响应中断: ${e?.message ?? e}`, { status: 502 });
    }
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (res.status === 429) {
      throw new RateLimitedError(bodyMessage(body, "懂了鸭请求过于频繁"), {
        // Never 0: a zero-second backoff re-fires into the rate limit and
        // turns a blip into a ban. Absent header means "no opinion".
        retryAfterSec: retryAfterOf(res),
        code: body?.codeName,
        details: body?.details,
      });
    }
    if (isBusinessFailure(res.status, body)) throw classify(res.status, body, text?.slice(0, 300));
    return body;
  }

  // ---- login -------------------------------------------------------------

  /** `GET /api/auth/config` — public. */
  async authConfig(signal) {
    return this.#fetch("/api/auth/config", { signal });
  }

  /** `POST /api/auth/sms/send-code` — `purpose` is omitted for plain login. */
  async sendVerifyCode(phone, signal) {
    return this.#fetch("/api/auth/sms/send-code", {
      method: "POST",
      json: { phone },
      signal,
    });
  }

  /** `POST /api/auth/sms/verify-code` → `{ success, token, user, isNewUser }`. */
  async verifyCode(phone, code, signal) {
    return this.#fetch("/api/auth/sms/verify-code", {
      method: "POST",
      json: { phone, code },
      signal,
    });
  }

  /** `GET /api/auth/me` — liveness probe and account identity. */
  async me(token, signal) {
    return this.#fetch("/api/auth/me", { token, signal });
  }

  // ---- invite gate -------------------------------------------------------

  /** This account's own invite code, offered to the next account.
   *  `GET /api/referral/me` → `{ data: { code, inviteUrl, inviteCount } }`. */
  async referralMe(token, signal) {
    return this.#fetch("/api/referral/me", { token, signal });
  }

  /**
   * Redeem an invite code against the access gate.
   *
   * `POST /api/access/redeem-invite` → `{ data: { code, kind, rewarded } }`.
   * An already-redeemed code is not an error: it comes back `success:true`
   * with `rewarded:false`, so retrying the chain is safe. A wrong code is
   * HTTP 200 with `codeName:"INVITE_INVALID"` and must be classified, not
   * thrown past the loader as a generic upstream fault.
   */
  async redeemInvite(token, code, signal) {
    return this.#fetch("/api/access/redeem-invite", {
      method: "POST",
      token,
      signal,
      json: { code: String(code ?? "").trim() },
    });
  }

  // ---- account -----------------------------------------------------------

  /** `GET /api/credits` → `{ success, data: { balance, creationCredits, ... } }`. */
  async credits(token, signal) {
    return this.#fetch("/api/credits", { token, signal });
  }

  /** `POST /api/credits/checkin` → `data.alreadyCheckedIn` drives the outcome. */
  async checkin(token, signal) {
    return this.#fetch("/api/credits/checkin", { method: "POST", token, signal });
  }

  /** `GET /api/models` — public, no token needed. */
  async models(signal) {
    return this.#fetch("/api/models", { signal });
  }

  // ---- chat --------------------------------------------------------------

  /**
   * `POST /api/v3/chat` — returns the parsed event iterator plus the response
   * so the caller can surface headers-first failures before committing to a
   * 200 stream.
   *
   * @param {object} body  vendor-shaped body (`{ messages, lang, extra }`)
   */
  async chatStream(body, { token, signal } = {}) {
    const headers = {
      ...baseHeaders(this.origin),
      "content-type": "application/json",
      accept: "text/event-stream",
      ...authHeaders(token ?? this.token),
    };
    // The web client's global fetch hook mirrors the body's sessionId into
    // this header on every same-origin /api* call. Cheap to replicate, and
    // the edge may key tracing/rate limits off it.
    if (body?.sessionId) headers["x-session-id"] = String(body.sessionId);

    const firstByte = new AbortController();
    const timer = setTimeout(() => firstByte.abort(new Error("first-byte timeout")), this.firstByteTimeoutMs);
    // `AbortSignal.any` composes rather than replaces: magpie's `init.signal`
    // still reaches the fetch, so the host can abandon the turn even while
    // the watchdog is armed.
    const effSignal = signal ? AbortSignal.any([signal, firstByte.signal]) : firstByte.signal;

    let res;
    try {
      res = await fetch(`${this.origin}/api/v3/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: effSignal,
        // Same rule as `#fetch`: the bearer token is a header, and `follow`
        // would take it wherever the redirect leads.
        redirect: "manual",
      });
    } catch (e) {
      clearTimeout(timer);
      // `abort(reason)` makes fetch reject with the reason *itself*, not an
      // `AbortError`, so this has to test the controller rather than
      // `e.name`. It was an `e.name === "AbortError"` guard, which never
      // matched: the raw English reason escaped to the gateway, which maps
      // an unknown error to 502 and lost the 504 this path exists to send.
      // Only *our* controller firing is a timeout — a caller's abort is
      // magpie abandoning the turn, and is not ours to relabel.
      if (firstByte.signal.aborted) {
        throw new UpstreamError("懂了鸭首字节超时", { status: 504 });
      }
      throw e;
    }

    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => {});
      throw new UpstreamError(`懂了鸭接口返回重定向（${res.status}），已拒绝跟随`, {
        status: 502,
      });
    }

    if (!res.ok) {
      clearTimeout(timer);
      // The first-byte watchdog fires on headers and is cleared right here.
      // An edge that sends a 5xx status line and then stalls would park this
      // read forever — the one half-open case the watchdog exists to cover.
      // Give the error body its own deadline; on expiry the status line alone
      // still classifies the failure.
      let bodyTimer;
      const text = await Promise.race([
        res.text().catch(() => ""),
        new Promise((resolve) => {
          bodyTimer = setTimeout(() => resolve(""), this.fetchTimeoutMs);
        }),
      ]);
      clearTimeout(bodyTimer);
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON error body */
      }
      if (res.status === 429) {
        throw new RateLimitedError(bodyMessage(parsed, "懂了鸭请求过于频繁"), {
          retryAfterSec: retryAfterOf(res),
        });
      }
      throw classify(res.status, parsed, text?.slice(0, 300) || `懂了鸭 HTTP ${res.status}`);
    }

    return { res, events: this.#eventIterator(res, firstByte, timer, signal), abort: () => firstByte.abort() };
  }

  /** Idle-watchdogged event iterator over a chat response.
   *  Framing itself comes from parseEventStream — one implementation, so a
   *  CRLF or split-frame bug can only ever be fixed in one place. The abort
   *  controller is the one driving the fetch, so an idle timeout here tears
   *  the response body down instead of leaving a reader parked forever. */
  async *#eventIterator(res, abortCtrl, firstByteTimer, callerSignal) {
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortCtrl.abort(new Error("idle timeout")), this.idleTimeoutMs);
    };

    try {
      armIdle();
      // Every framed block resets the watchdog, including the ones that
      // parse to nothing (heartbeats, comments) — the loop body's own
      // re-arm only covers blocks that yielded an event.
      const onFrame = () => {
        clearTimeout(firstByteTimer);
        armIdle();
      };
      for await (const ev of parseEventStream(res.body, onFrame)) yield ev;
    } catch (e) {
      if (callerSignal?.aborted) throw e;
      if (abortCtrl.signal.aborted) {
        // Both watchdogs abort *with* a reason; a deliberate cancel aborts
        // bare. Labelling every abort "空闲超时" logged a phantom timeout for
        // every client that hung up mid-read, and sent the 3am pager looking
        // at the vendor's latency instead of at the client. The first-byte
        // timer is armed before the idle one and wins the race whenever the
        // vendor sends headers and then nothing, so it needs its own branch —
        // it used to fall through to the cancelled one and report a timeout
        // as a client hang-up.
        const reason = String(abortCtrl.signal.reason?.message ?? "");
        if (reason === "idle timeout") {
          throw new UpstreamError("懂了鸭流空闲超时", { status: 504 });
        }
        if (reason === "first-byte timeout") {
          throw new UpstreamError("懂了鸭首字节超时", { status: 504 });
        }
        // Cancelled on purpose. There is nobody left to read a status, and
        // inventing one (499) made the gateway fail over to another account
        // for a turn the caller had already abandoned. Hand back the
        // standard AbortError instead.
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      throw new UpstreamError("懂了鸭流中断", { status: 502 });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(firstByteTimer);
      abortCtrl.abort(); // no-op if the stream already ended cleanly
    }
  }

  /** `POST /api/v3/chat/abort` — best-effort stop. */
  async abortChat(sessionId, token, signal) {
    try {
      await this.#fetch("/api/v3/chat/abort", {
        method: "POST",
        json: { sessionId },
        token,
        signal,
      });
    } catch (e) {
      this.onLog("warn", `abort 失败: ${e?.message ?? e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Decode a JWT payload without verifying (we only read `exp`/`userId`). */
export function decodeJwt(token) {
  try {
    const part = String(token ?? "").split(".")[1];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Epoch ms at which the token expires, or undefined when it carries no `exp`. */
export function jwtExpiry(token) {
  const payload = decodeJwt(token);
  const exp = payload?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

/** Mask a phone number for display: 138****1234. */
export function maskPhone(phone) {
  const s = String(phone ?? "");
  if (s.length !== 11) return s ? `${s.slice(0, 3)}****` : "";
  return `${s.slice(0, 3)}****${s.slice(7)}`;
}

export const DEFAULT_MODEL = "auto";
export { ORIGIN, BROWSER_UA };
