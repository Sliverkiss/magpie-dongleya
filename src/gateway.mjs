// src/gateway.mjs — OpenAI Chat Completions <-> dongleya translation.
//
// magpie hands the plugin's fetch a Chat Completions request body (the loader
// npm is @ai-sdk/openai-compatible) and expects an OpenAI Chat Completions
// reply back: streamed SSE chunks or one JSON completion. This module owns
// that translation and the OpenAI-shaped error answers.
//
// Turn model: the vendor's /api/v3/chat takes the FULL message array plus a
// sessionId and keeps the conversation server-side, so we replay the whole
// history on every call and let the server hold context. No dialog chaining.

import {
  DongleyaClient,
  UpstreamError,
  AuthExpiredError,
  RateLimitedError,
  InviteRequiredError,
  InvalidInputError,
  inviteMessage,
  ClientRejectedError,
  ModelNotFoundError,
  ContentFilterError,
  InsufficientCreditsError,
  StreamFrameError,
  DEFAULT_MODEL,
} from "./dongleya.mjs";

// ---------------------------------------------------------------------------
// OpenAI shaping
// ---------------------------------------------------------------------------

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

const HEX = "0123456789abcdef";
function randomHex(n = 24) {
  let s = "";
  for (let i = 0; i < n; i++) s += HEX[(Math.random() * 16) | 0];
  return s;
}

const chatID = () => `chatcmpl-${randomHex(24)}`;

function chunkBody(id, model, created, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function completionBody(id, model, created, content, reasoning, finishReason = "stop") {
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** ERROR-CODES §3, v1 — frozen. A plugin may not invent its own words.
 *  magpie routes on `status` and agents branch on `code`, so a code outside
 *  this set is a code nobody can act on. */
export const CODES = Object.freeze({
  signInRequired: "sign_in_required",
  sessionExpired: "session_expired",
  auditBlocked: "audit_blocked",
  invalidRequest: "invalid_request",
  modelNotFound: "model_not_found",
  concurrencyConflict: "concurrency_conflict",
  rateLimited: "rate_limited",
  upstreamUnavailable: "upstream_unavailable",
  upstreamTimeout: "upstream_timeout",
  upstreamError: "upstream_error",
  internalError: "internal_error",
  notImplemented: "not_implemented",
});

const CODE_BY_STATUS = Object.freeze({
  400: CODES.invalidRequest,
  401: CODES.sessionExpired,
  404: CODES.modelNotFound,
  409: CODES.concurrencyConflict,
  429: CODES.rateLimited,
  501: CODES.notImplemented,
  502: CODES.upstreamError,
  503: CODES.upstreamUnavailable,
  504: CODES.upstreamTimeout,
});

/** The vocabulary code for a status. Every exit that has nothing more
 *  specific to say falls back to this, so no response ever ships a numeric
 *  code or a word outside §3. */
export function codeForStatus(status) {
  return CODE_BY_STATUS[status] ?? CODES.upstreamError;
}

/** The §3 code for an error.
 *
 *  Deliberately *not* a passthrough of `err.code`: on several classes that
 *  field is the vendor's own business code (`20003`, `INVITE_INVALID`), and
 *  an agent branching on those matches nothing. Map by type; the vendor's
 *  code stays in the message where it belongs. */
export function errorCode(err, status) {
  if (err instanceof InviteRequiredError) return CODES.signInRequired;
  if (err instanceof AuthExpiredError) return CODES.sessionExpired;
  if (err instanceof ContentFilterError) return CODES.auditBlocked;
  if (err instanceof ModelNotFoundError) return CODES.modelNotFound;
  if (err instanceof RateLimitedError) return CODES.rateLimited;
  if (err instanceof InvalidInputError) return CODES.invalidRequest;
  if (err instanceof GatewayError) return err.code ?? codeForStatus(status);
  if (err instanceof StreamFrameError) {
    if (err.kind === "busy") return CODES.upstreamUnavailable;
    if (err.kind === "model-rejected") return CODES.modelNotFound;
    return CODES.upstreamError;
  }
  return codeForStatus(status);
}

/** An OpenAI-shaped error so agents show the platform's own words.
 *  `status` is repeated inside the envelope because a streamed failure cannot
 *  carry it in the status line (§1: all three fields, or the error says
 *  nothing magpie can decide with). */
export function openaiError(status, message, type = "upstream_error", code, headers = {}) {
  return new Response(
    JSON.stringify({
      error: { message, type, code: code ?? codeForStatus(status), status },
    }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

export class GatewayError extends Error {
  constructor(status, message, type, code) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
  toResponse() {
    return openaiError(this.status, this.message, this.type, this.code);
  }
}

/** Map an upstream failure onto an OpenAI status. 401 is reserved for auth. */
export function errorStatus(err) {
  if (err instanceof AuthExpiredError) return 401;
  if (err instanceof InvalidInputError) return 400;
  // 502, not 403: the account is fine and re-login will not help. This is the
  // plugin's fingerprint being stale, so it should read as an upstream fault.
  if (err instanceof ClientRejectedError) return 502;
  if (err instanceof ModelNotFoundError) return 404;
  if (err instanceof ContentFilterError) return 400;
  // 402 does not exist in the host's table. Credits are an account-level
  // wall, and another account clears it — which is exactly what 502 tells
  // magpie to try. A 4xx would make it retry the broke account forever.
  if (err instanceof InsufficientCreditsError) return 502;
  // An invite gate is not an auth expiry, but 403 is not a status magpie
  // knows either. 401 plus `X-Magpie-Sign-In: kept` says both things at
  // once: this is an access problem, and the session is not dead — so
  // magpie shows it without offering a pointless re-sign-in.
  if (err instanceof InviteRequiredError) return 401;
  if (err instanceof RateLimitedError) return 429;
  if (err instanceof GatewayError) return err.status;
  if (err instanceof StreamFrameError) {
    if (err.kind === "busy") return 503; // transient: failover/retry is correct
    // The model refused deterministically. 404 is the one status that
    // shelves just this model; 403 is unknown to the host and would retry.
    if (err.kind === "model-rejected") return 404;
    return 502;
  }
  if (err instanceof UpstreamError) return err.status;
  return 502;
}

/** Resolve the requested model id against the account catalog. */
export function resolveModel(requested, catalogModels) {
  const ids = (catalogModels ?? []).map((m) => m.id);
  if (!ids.length) return requested || DEFAULT_MODEL; // degraded: upstream decides
  if (!requested || requested.toLowerCase() === "auto") return DEFAULT_MODEL;
  const hit = ids.find((id) => id === requested);
  if (hit) return hit;
  const lower = new Map(ids.map((id) => [id.toLowerCase(), id]));
  const loose = lower.get(String(requested).toLowerCase());
  if (loose) return loose;
  throw new ModelNotFoundError(requested, [...ids].sort());
}

// ---------------------------------------------------------------------------
// message translation
// ---------------------------------------------------------------------------

/** Flatten an OpenAI content value into plain text. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

// The vendor's `/api/v3/chat` has no `tools` field: it takes a transcript of
// user/assistant text and nothing else. magpie's side of the bargain (its
// `toolsTold`, which sets `tool_call: true` on every chat model it lists) is
// that a model writing its call into its text gets it back as a real call —
// `textCallTidy` holds the text from the first `<tool_call>` mark and turns
// each block naming an offered tool into a call. So the plugin tells the
// model about the tools in the prompt, in exactly that block shape, and lets
// magpie lift the calls back out. Refusing the request instead (which this
// did until now) made every agent turn a 400, because magpie never takes a
// model off the tool-capable list.
const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

/** A value as JSON text, never throwing. */
function jsonText(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? {}) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * One assistant tool_calls entry as the text block magpie reads back.
 *
 * `arguments` arrives as a JSON string in OpenAI's shape, but a relay may hand
 * over an object, and a model rewriting its own history may hand over neither.
 */
function renderToolCall(call) {
  const fn = call?.function ?? call;
  const name = typeof fn?.name === "string" ? fn.name : "";
  if (!name) return "";
  let args = fn?.arguments ?? call?.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // Not JSON: keep the model's words rather than silently dropping them.
      args = { value: args };
    }
  }
  return `${TOOL_CALL_OPEN}${JSON.stringify({ name, arguments: args ?? {} })}${TOOL_CALL_CLOSE}`;
}

/**
 * The prompt section that tells the model which tools it has.
 *
 * Empty when the request offered none, or asked for none (`tool_choice:
 * "none"`): with no tools declared the model has nothing to call, and magpie
 * isn't watching for the blocks either — it only lifts them out of a reply to
 * a request that carried tools.
 */
function renderTools(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  if (toolChoice === "none") return "";
  const lines = [
    "你可以调用以下工具。需要调用时，在回复里写出一个这样的块（块内只有这段 JSON，不要有其他文字）：",
    `${TOOL_CALL_OPEN}{"name": "<工具名>", "arguments": { ... }}</tool_call>`,
    "只能调用下面列出的工具；参数按各自的 schema 给出。不需要调用工具时，正常用文字回答。",
    "",
  ];
  for (const t of tools) {
    const fn = t?.function ?? t;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) continue;
    const desc = typeof fn?.description === "string" ? fn.description : "";
    lines.push(`- ${name}${desc ? `：${desc}` : ""}`);
    if (fn?.parameters) lines.push(`  parameters: ${jsonText(fn.parameters)}`);
  }
  return lines.join("\n");
}

/**
 * OpenAI messages -> vendor messages.
 *
 * The vendor accepts only `user` / `assistant` roles, so system and developer
 * prompts are spliced into the first user turn (same convention as the
 * sibling 2api gateways). Consecutive same-role turns are merged, because the
 * vendor's replay is a plain transcript and two user turns back to back read
 * as one message anyway.
 *
 * Tool traffic is rendered into that same text transcript: an assistant turn's
 * `tool_calls` become `<tool_call>` blocks (the shape magpie lifts back out),
 * and a `tool` result becomes a `<tool_result>` block on the user side, which
 * is whose words a result actually is. Nothing is dropped — a transcript with
 * holes in it is what made the model answer a conversation that never
 * happened.
 *
 * @param {Array<object>} messages
 * @param {{ tools?: Array<object>, toolChoice?: unknown }} [opts]
 * @returns {{ messages: Array<{role:string, content:string}>, promptText: string }}
 */
export function toVendorMessages(messages, { tools, toolChoice } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayError(400, "messages must be a non-empty array", "invalid_request_error");
  }

  const systemParts = [];
  const turns = [];
  const push = (role, text) => {
    if (!text) return;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${text}`;
    else turns.push({ role, content: text });
  };

  for (const m of messages) {
    const role = m?.role;
    if (role === "system" || role === "developer") {
      const text = contentText(m?.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "tool") {
      const id = typeof m?.tool_call_id === "string" ? m.tool_call_id : "";
      const body = contentText(m?.content);
      push("user", `<tool_result${id ? ` tool_call_id="${id}"` : ""}>${body}</tool_result>`);
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;

    let text = contentText(m?.content);
    if (role === "assistant" && Array.isArray(m?.tool_calls)) {
      const calls = m.tool_calls.map(renderToolCall).filter(Boolean).join("\n");
      if (calls) text = text ? `${text}\n${calls}` : calls;
    }
    push(role, text);
  }

  if (turns.length === 0) {
    throw new GatewayError(400, "no user message to send", "invalid_request_error");
  }

  // A transcript must start with the user, and the last turn must be the user's
  // (the vendor generates the assistant reply).
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (turns.length === 0) {
    throw new GatewayError(400, "no user message to send", "invalid_request_error");
  }
  while (turns.length && turns[turns.length - 1].role !== "user") turns.pop();
  if (turns.length === 0) {
    throw new GatewayError(400, "the last message must come from the user", "invalid_request_error");
  }

  // Tool instructions go last so the model reads them directly before the
  // transcript starts — and only after the caller's own system prompt, which
  // they must not outrank.
  const toolSection = renderTools(tools, toolChoice);
  if (toolSection) systemParts.push(toolSection);

  if (systemParts.length) {
    turns[0].content = `${systemParts.join("\n\n")}\n\n${turns[0].content}`;
  }

  const promptText = turns.map((t) => t.content).join("\n");
  return { messages: turns, promptText };
}

/** Rough prompt size, used only for the usage estimate. */
function estimateTokens(text) {
  // ~4 chars per token for mixed CJK/latin; the vendor does not report usage
  // on the stream, so this is a display figure, not a billing one.
  return Math.max(1, Math.ceil(String(text ?? "").length / 4));
}

// ---------------------------------------------------------------------------
// vendor body
// ---------------------------------------------------------------------------

/**
 * Build the /api/v3/chat body.
 *
 * Only the fields the vendor actually reads are set; everything optional in
 * its schema (attachments, artifacts, skills, interaction results) stays
 * absent rather than null, because the server treats presence as intent.
 */
export function toVendorBody({ messages, model, reasoningEffort, lang, sessionId }) {
  const body = {
    messages,
    lang: lang === "en" ? "en" : "zh",
    extra: {
      model,
      modelUiId: model,
      modelSelectionSource: "api",
      modelFromUiClick: false,
    },
  };
  if (reasoningEffort) body.extra.reasoningEffort = reasoningEffort;
  if (sessionId) body.sessionId = sessionId;
  return body;
}

/** Normalize an incoming reasoning_effort into the vendor's enum. */
export function normalizeEffort(input) {
  const s = String(input ?? "").toLowerCase();
  if (s === "low" || s === "medium" || s === "high" || s === "max") return s;
  if (s === "minimal" || s === "none" || s === "off") return "low";
  return "";
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

/**
 * Run one Chat Completions request against one account.
 *
 * @param {DongleyaClient} client
 * @param {{ token: string }} session
 * @param {{ catalog?: { models: Array<{id: string}> } }} accountState
 * @param {object} body   Chat Completions request
 * @param {{ signal?: AbortSignal }} opts
 */
export async function handleChatCompletion(client, session, accountState, body, { signal } = {}) {
  if (!body || !Array.isArray(body.messages)) {
    throw new GatewayError(400, "request body must carry a messages array", "invalid_request_error");
  }

  // The vendor has no `tools` field. Rather than refuse the request — which
  // made every agent turn a 400, since magpie advertises `tool_call: true` on
  // every chat model it lists — the offered tools are rendered into the prompt
  // and the model writes its call back as text, where magpie's `textCallTidy`
  // lifts it into a real call. See `renderTools`.
  const requested = typeof body.model === "string" ? body.model.trim() : "";
  const model = resolveModel(requested, accountState?.catalog?.models);
  const reasoningEffort = normalizeEffort(body.reasoning_effort ?? body.reasoningEffort);

  const { messages, promptText } = toVendorMessages(body.messages, {
    tools: body.tools,
    toolChoice: body.tool_choice,
  });
  const vendorBody = toVendorBody({ messages, model, reasoningEffort, lang: body.lang });
  const wantsStream = body.stream === true;

  const id = chatID();
  const created = nowUnix();
  const token = session?.token;

  // ---- non-streaming ----
  if (!wantsStream) {
    let content = "";
    let reasoning = "";
    let stopReason = "completed";
    let sawFinish = false;
    let vendorSessionId = null;

    const { events, abort } = await client.chatStream(vendorBody, { token, signal });
    try {
      for await (const ev of events) {
        const t = ev?.type;
        if (t === "text-delta") content += ev.delta ?? "";
        else if (t === "reasoning-delta") reasoning += ev.delta ?? "";
        else if (t === "session-created") vendorSessionId = ev.sessionId ?? vendorSessionId;
        else if (t === "error") throw inBandError(ev);
        else if (t === "finish") {
          sawFinish = true;
          stopReason = ev.stopReason ?? "completed";
          break;
        }
      }
    } catch (e) {
      // Tearing down the local stream does not stop the vendor: it keeps
      // generating against a paid model until it finishes on its own. Abort
      // is best-effort and already swallows failures.
      if (vendorSessionId) client.abortChat(vendorSessionId, token).catch(() => {});
      throw e;
    } finally {
      abort();
    }

    // Same rule as the streaming path: a clean EOF with no `finish` frame is
    // a truncated generation, not a short answer. Nothing throws on it —
    // `reader.read()` just returns `done: true` — so without this the client
    // gets a cut reply marked a clean stop, at full price.
    if (!sawFinish) {
      throw new GatewayError(
        504,
        "上游流在 finish 帧之前结束",
        "upstream_error",
        CODES.upstreamTimeout,
      );
    }

    assertStopReason(stopReason);
    // `mapFinishReason` used to be applied on the stream only, so
    // `max_duration` read as `length` there and as `stop` here, for the same
    // upstream condition.
    const out = completionBody(id, model, created, content, reasoning, mapFinishReason(stopReason));
    out.usage = {
      prompt_tokens: estimateTokens(promptText),
      completion_tokens: estimateTokens(content),
      total_tokens: estimateTokens(promptText) + estimateTokens(content),
    };
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // ---- streaming ----
  // The 200 is gated on the first upstream event: an auth failure must throw
  // out of here so magpie can mark the account, not vanish as an error frame
  // inside an already-committed SSE response.
  //
  // This has to happen *before* the ReadableStream is built. `new
  // ReadableStream({async start})` calls `start` synchronously and returns at
  // its first `await`, so a check placed after the constructor always sees
  // `firstEvent === null` — the gate was dead code that let a gated account
  // ship as HTTP 200 + an error frame, which magpie cannot act on: it never
  // marks the account and retries the dead session on every turn.
  const encoder = new TextEncoder();
  let closed = false;
  let vendorSessionId = null;

  const upstream = await client.chatStream(vendorBody, { token, signal });

  const iterator = upstream.events[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.value?.type === "error") {
    upstream.abort();
    // Same teardown as the wrapper's finally: without it the inner
    // generator stays suspended at its yield and its idle timer stays armed.
    try {
      await iterator.return?.();
    } catch {
      /* already torn down */
    }
    throw inBandError(first.value);
  }
  // The vendor opens every run with `session-created`, and this gate already
  // consumed it. Take the id here, before the stream is handed to magpie:
  // once the consumer cancels, the `for await` below is torn down and no
  // further frame ever arrives, so a cancel that raced the first read had no
  // id to abort the vendor run with and left it billing.
  if (first.value?.type === "session-created") {
    vendorSessionId = first.value.sessionId ?? null;
  }

  const readable = new ReadableStream({
    async start(ctrl) {
      const send = (obj) => {
        if (!closed) ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      // OpenAI's terminator is the bare literal, never JSON.stringify'd.
      const sendDone = () => {
        if (!closed) ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
      };

      let content = "";
      let reasoning = "";
      let stopReason = "completed";
      let sawFinish = false;

      try {
        // Role chunk first, so clients see a well-formed message start.
        send(chunkBody(id, model, created, { role: "assistant", content: "" }));

        // Replay the event pulled above, then drain the rest of the stream.
        const events = (async function* () {
          try {
            if (!first.done) yield first.value;
            while (true) {
              const n = await iterator.next();
              if (n.done) return;
              yield n.value;
            }
          } finally {
            // Closing this wrapper has to close the vendor iterator too.
            // `for await` calls `events.return()`, which resumes this
            // generator at its `yield` and runs this block — but nothing
            // resumes `iterator` itself, so without the explicit `.return()`
            // the inner generator stays suspended forever, holding the
            // first-byte and idle timers (60s each) and the whole response
            // closure with them, once per streamed turn.
            //
            // Abort before unwinding: `.return()` on a generator parked in
            // a body read only settles once that read does, and
            // `upstream.abort()` is what ends it. The outer `finally` still
            // aborts for the paths that never build this generator.
            upstream.abort();
            // Best effort, like the `ctrl.close()` above: the inner
            // generator unwinds through its own catch when the abort lands
            // mid-read, so `.return()` can reject with "流已中止". Nobody
            // upstream can act on that — the stream is already over.
            try {
              await iterator.return?.();
            } catch {
              /* already torn down */
            }
          }
        })();

        for await (const ev of events) {
          if (closed) break;

          const t = ev?.type;
          if (t === "text-delta") {
            const d = ev.delta ?? "";
            if (!d) continue;
            content += d;
            send(chunkBody(id, model, created, { content: d }));
          } else if (t === "reasoning-delta") {
            const d = ev.delta ?? "";
            if (!d) continue;
            reasoning += d;
            send(chunkBody(id, model, created, { reasoning_content: d }));
          } else if (t === "error") {
            // In-band failure: headers are committed, so this has to be an
            // error frame the client can surface, not an HTTP status.
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "error" }],
              error: { message: ev.message ?? "上游生成失败", code: ev.code ?? "UPSTREAM_ERROR" },
            });
            sendDone();
            closed = true;
            ctrl.close();
            return;
          } else if (t === "session-created") {
            vendorSessionId = ev.sessionId ?? vendorSessionId;
          } else if (t === "finish") {
            sawFinish = true;
            stopReason = ev.stopReason ?? "completed";
            break;
          }
        }

        if (closed) return;

        // A clean EOF with no `finish` frame is a truncated generation: the
        // vendor died, a proxy drained, or a server-side abort skipped the
        // frame. None of those throw — `reader.read()` just returns
        // `done: true` — so without this the client gets a cut answer marked
        // a clean stop, at full price. Say so instead.
        if (!sawFinish) {
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "error" }],
            error: {
              message: "上游流在 finish 帧之前结束",
              code: CODES.upstreamTimeout,
              status: 504,
            },
          });
          sendDone();
          return;
        }

        // A `finish` frame carrying a failure reason is not a clean stop.
        // The status is already spent on 200, so say so in-band.
        const failure = stopReasonFailure(stopReason);
        if (failure) {
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "error" }],
            error: failure,
          });
          sendDone();
          return;
        }

        const finishReason = mapFinishReason(stopReason);
        send(chunkBody(id, model, created, {}, finishReason));

        // Usage is not reported by the vendor on the stream; estimate it so
        // magpie's quota display is not permanently zero.
        const promptTokens = estimateTokens(promptText);
        const completionTokens = estimateTokens(content);
        send({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        });
        sendDone();
      } catch (e) {
        if (!closed) {
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "error" }],
            error: {
              message: e?.message ?? "上游流中断",
              code: e?.code ?? "STREAM_ERROR",
            },
          });
          sendDone();
        }
      } finally {
        closed = true;
        try {
          ctrl.close();
        } catch {
          /* already closed */
        }
        upstream.abort();
      }
    },
    cancel() {
      closed = true;
      upstream?.abort();
      // magpie hanging up is not the vendor hanging up: without this the
      // generation runs to completion server-side and bills for output
      // nobody reads. The id is captured at the gate above, so it is known
      // before the first byte reaches magpie — a cancel can always stop the
      // run, not just drop the connection.
      if (vendorSessionId) client.abortChat(vendorSessionId, token).catch(() => {});
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * In-band `error` frame -> error class.
 *
 * Must agree with `classify` case for case, or the same vendor condition
 * becomes a different magpie answer depending on whether it arrived as an
 * HTTP envelope or as a frame inside an already-200 stream. Two drifted:
 *
 *   HTML_MODERATION_REJECTED — classify says ContentFilterError (400, not
 *     retryable); falling through to "unknown" made it a 502, so magpie
 *     failed over and sprayed the same flagged prompt at the next account.
 *   CONTEXT_TOO_LONG — classify says 400 (the prompt is too big; retrying
 *     elsewhere won't help); "model-rejected" made it a 403.
 */
function inBandError(ev) {
  const code = String(ev?.code ?? "");
  const message = ev?.message ?? "懂了鸭生成失败";
  if (code === "INSUFFICIENT_CREDITS") return new InsufficientCreditsError(message);
  if (code === "INVITE_REQUIRED") return new InviteRequiredError(inviteMessage(message));
  if (code === "CONTENT_FILTER" || code === "HTML_MODERATION_REJECTED") {
    return new ContentFilterError(message);
  }
  if (code === "MODEL_BUSY" || code === "GENERATION_IN_PROGRESS") {
    return new StreamFrameError(message, { kind: "busy", code });
  }
  if (code === "MODEL_FAILED" || code === "MODEL_REJECTED" || code === "MODEL_STALLED") {
    return new StreamFrameError(message, { kind: "model-rejected", code });
  }
  if (code === "CONTEXT_TOO_LONG") {
    return new UpstreamError(message, { status: 400, codeName: code });
  }
  return new StreamFrameError(message, { kind: "unknown", code });
}

function mapFinishReason(stopReason) {
  switch (stopReason) {
    case "completed":
    case "stopped":
      return "stop";
    case "max_duration":
      return "length";
    default:
      return "stop";
  }
}

/**
 * A `finish` frame can carry a failure reason instead of a clean stop.
 *
 * The non-streaming path turns these into the matching HTTP status, so
 * magpie can mark the account or retry. The streaming path has already
 * committed to 200 and cannot take the status back — but reporting them as
 * `stop` is worse than useless: a filtered or credit-starved reply arrives
 * marked a complete answer and is billed as one. Both paths read this
 * table; only the delivery differs.
 */
const STOP_REASON_FAILURES = {
  content_filter: {
    message: "内容被懂了鸭安全策略拦截",
    code: CODES.auditBlocked,
    status: 400,
  },
  // Credits are an account-level wall. 502 is the status that says "another
  // account clears this, this one never will" — 503 would retry the broke
  // account, and 402 is not in the host's table at all.
  insufficient_credits: {
    message: "懂了鸭积分不足",
    code: CODES.upstreamError,
    status: 502,
  },
  model_stalled: {
    message: "懂了鸭模型响应停滞",
    code: CODES.upstreamTimeout,
    status: 504,
  },
  error: {
    message: "懂了鸭生成失败",
    code: CODES.upstreamError,
    status: 502,
  },
};

function stopReasonFailure(stopReason) {
  return STOP_REASON_FAILURES[stopReason] ?? null;
}

function assertStopReason(stopReason) {
  const failure = stopReasonFailure(stopReason);
  if (!failure) return;
  // 400 is the audit wall — the one failure another account will refuse just
  // as fast, so it must not read as retryable. Everything else is an upstream
  // fault and carries its own status.
  if (failure.status === 400) throw new ContentFilterError(failure.message);
  throw new GatewayError(failure.status, failure.message, "upstream_error", failure.code);
}
