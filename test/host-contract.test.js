// test/host-contract.test.js — the plugin against magpie's side of the
// contract, not the vendor's.
//
// magpie's `fetch` contract (docs/zh/plugins § 请求) is exactly two rules:
// `init.signal` aborts when the agent gives up, and the body is relayed
// chunk by chunk. There is no host-side deadline — internal/plugin/host.js
// wraps `load` and `provider.models` in `inTime(...)` and leaves `doFetch`
// bare. So the streaming watchdogs are the plugin's own, and these tests
// pin the two things that follow: they must compose with the caller's
// signal rather than replace it, and they must surface as the documented
// 504 rather than as whatever `fetch` happens to reject with.
import { describe, test, expect, afterEach } from "bun:test";
import {
  DongleyaClient,
  UpstreamError,
  AuthExpiredError,
  RateLimitedError,
  InviteRequiredError,
  ModelNotFoundError,
  ContentFilterError,
  InsufficientCreditsError,
  ClientRejectedError,
  InvalidInputError,
  StreamFrameError,
} from "../src/dongleya.mjs";
import { handleChatCompletion, errorStatus, errorCode, openaiError, GatewayError } from "../src/gateway.mjs";
import { _internal } from "../index.mjs";

const ENC = new TextEncoder();
const servers = [];
afterEach(() => {
  while (servers.length) {
    try {
      servers.pop().stop(true);
    } catch {
      /* already stopped */
    }
  }
});

/** A vendor that accepts the connection and never sends a byte. */
function silentServer() {
  const s = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
  servers.push(s);
  return { origin: `http://127.0.0.1:${s.port}` };
}

/** A vendor that sends headers and one frame, then goes quiet. */
function stallingServer() {
  const s = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(ENC.encode(`data: {"type":"session-created","sessionId":"s1"}\n\n`));
            // no more chunks, no close: the stream stalls with the socket up
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  servers.push(s);
  return { origin: `http://127.0.0.1:${s.port}` };
}

const BODY = { messages: [{ role: "user", content: "hi" }], extra: { model: "auto" } };

describe("streaming watchdogs", () => {
  test("a vendor that never sends headers surfaces as a 504, not a raw Error", async () => {
    const { origin } = silentServer();
    const c = new DongleyaClient({ origin, token: "t", firstByteTimeoutMs: 25 });

    const err = await c.chatStream(BODY).then(
      () => null,
      (e) => e,
    );

    // `abort(reason)` makes fetch reject with the reason *itself* — name
    // "Error", not "AbortError" — so an `e.name === "AbortError"` guard
    // never fires and the raw English reason escapes to the gateway, which
    // maps an unknown error to 502. The watchdog owes magpie a 504.
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(504);
    expect(err.message).toContain("首字节超时");
  });

  test("a stream that goes silent mid-body surfaces as a 504", async () => {
    const { origin } = stallingServer();
    const c = new DongleyaClient({ origin, token: "t", idleTimeoutMs: 25 });

    const { events } = await c.chatStream(BODY);
    const err = await (async () => {
      try {
        for await (const _ of events) {
          /* drain until the watchdog fires */
        }
      } catch (e) {
        return e;
      }
      return null;
    })();

    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(504);
    expect(err.message).toContain("空闲超时");
  });

  test("a caller abort is never relabelled as a vendor timeout", async () => {
    const { origin } = stallingServer();
    const c = new DongleyaClient({ origin, token: "t", idleTimeoutMs: 10_000 });
    const caller = new AbortController();

    const { events } = await c.chatStream(BODY, { signal: caller.signal });
    const err = await (async () => {
      try {
        for await (const _ of events) {
          caller.abort(); // the agent hung up, not the vendor
        }
      } catch (e) {
        return e;
      }
      return null;
    })();

    // magpie uses the abort to decide the turn was abandoned; a 504 here
    // would page someone about vendor latency that never happened.
    expect(err?.message ?? "").not.toContain("超时");
  });
});

describe("gateway teardown", () => {
  test("the vendor iterator is unwound when the stream ends", async () => {
    let returned = false;
    const client = {
      async chatStream() {
        return {
          res: new Response(null, { status: 200 }),
          events: {
            [Symbol.asyncIterator]() {
              let served = false;
              return {
                async next() {
                  if (served) return { done: true, value: undefined };
                  served = true;
                  return { done: false, value: { type: "finish", stopReason: "completed" } };
                },
                async return() {
                  returned = true;
                  return { done: true, value: undefined };
                },
              };
            },
          },
          abort() {},
        };
      },
      async abortChat() {},
    };

    const res = await handleChatCompletion(client, { token: "t", userId: "u" }, {}, {
      ...BODY,
      // The streaming branch is gated on this; without it the request takes
      // the JSON path, which has its own teardown and hides the leak.
      stream: true,
    });
    await res.text(); // drain so the ReadableStream's teardown runs

    // Nothing else ever resumes the inner generator: it owns the first-byte
    // and idle timers, so leaving it suspended pins both (and the whole
    // response closure) for the full 60s after every streamed turn.
    expect(returned).toBe(true);
  });

  test("a rejecting iterator teardown does not take the response down with it", async () => {
    // When the abort lands while the inner generator is parked in a body
    // read, it unwinds through its own catch and `.return()` rejects with
    // "流已中止". Unhandled, that rejection errors the ReadableStream and
    // the client loses a reply that already finished.
    const client = {
      async chatStream() {
        return {
          res: new Response(null, { status: 200 }),
          events: {
            [Symbol.asyncIterator]() {
              let served = false;
              return {
                async next() {
                  if (served) return { done: true, value: undefined };
                  served = true;
                  return { done: false, value: { type: "finish", stopReason: "completed" } };
                },
                async return() {
                  throw new Error("懂了鸭流已中止");
                },
              };
            },
          },
          abort() {},
        };
      },
      async abortChat() {},
    };

    const res = await handleChatCompletion(client, { token: "t", userId: "u" }, {}, {
      ...BODY,
      stream: true,
    });

    const text = await res.text();
    // The turn finished cleanly before the teardown ran, so a teardown
    // failure must not rewrite it into a failed generation — the client
    // would be told the answer it just received is an error.
    expect(text).not.toContain('"finish_reason":"error"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });
});

describe("per-account scope", () => {
  test("two tokens from the same issuer get different scopes", () => {
    // A JWT's first 32 chars are its header — base64url of
    // {alg,typ} — which is identical for every token the same issuer
    // mints. Keying state on that prefix collapses every account into one
    // entry, so catalog and quota cross-contaminate.
    // Same 32-char header, different payload — exactly what two sign-ins
    // against one issuer look like.
    const hdr = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url").slice(0, 32);
    const a = _internal.scopeKey({ token: `${hdr}.payload-one.sig` });
    const b = _internal.scopeKey({ token: `${hdr}.payload-two.sig` });
    expect(a).not.toBe(b);
  });

  test("a JWT carrying a userId keys on the userId, not the token", () => {
    // userId is stable across re-login; the token is not. Keying on the
    // stable one is what lets a refreshed session find its own state.
    const first = _internal.scopeKey({ userId: "u_1", token: "eyJ.one.sig" });
    const second = _internal.scopeKey({ userId: "u_1", token: "eyJ.two.sig" });
    expect(first).toBe(second);
  });
});

describe("catalog backoff", () => {
  test("a stale catalog does not refetch while the vendor is down", async () => {
    const HOUR = 3600_000;
    // Cached but expired, no failure recorded yet: the first call refetches,
    // the vendor fails, and every call after it must back off. The `else if`
    // this replaced only ran when there was no catalog at all, so a stale
    // catalog skipped the backoff entirely and refetched on every turn.
    const s = {
      catalog: { rows: [], models: [] },
      catalogAt: Date.now() - 7 * HOUR,
      catalogFailedAt: 0,
      catalogPromise: null,
    };
    let calls = 0;
    const client = {
      async models() {
        calls++;
        throw new Error("vendor down");
      },
    };

    await _internal.loadCatalog(null, s, client).catch(() => {});
    await _internal.loadCatalog(null, s, client).catch(() => {});
    await _internal.loadCatalog(null, s, client).catch(() => {});

    expect(calls).toBe(1);
  });
});

describe("streamed failure reasons", () => {
  // A `finish` frame can carry a failure reason instead of a clean stop. The
  // status is already spent on 200, so the plugin has to say so in-band —
  // otherwise a filtered or credit-starved reply reaches magpie marked a
  // complete answer and is billed as one.
  // Codes come from the host's frozen vocabulary (§3), never from the
  // vendor's own words. The frame also has to carry `status`: the status line
  // is already spent on 200, so without it the error says nothing magpie can
  // decide with.
  for (const [stopReason, code, status] of [
    ["content_filter", "audit_blocked", 400],
    ["insufficient_credits", "upstream_error", 502],
    ["model_stalled", "upstream_timeout", 504],
    ["error", "upstream_error", 502],
  ]) {
    test(`${stopReason} finishes as an error frame, not a clean stop`, async () => {
      const client = {
        async chatStream() {
          return {
            res: new Response(null, { status: 200 }),
            events: {
              [Symbol.asyncIterator]() {
                let served = false;
                return {
                  async next() {
                    if (served) return { done: true, value: undefined };
                    served = true;
                    return { done: false, value: { type: "finish", stopReason } };
                  },
                  async return() {
                    return { done: true, value: undefined };
                  },
                };
              },
            },
            abort() {},
          };
        },
        async abortChat() {},
      };

      const res = await handleChatCompletion(client, { token: "t", userId: "u" }, {}, {
        ...BODY,
        stream: true,
      });

      const text = await res.text();
      expect(text).toContain(`"code":"${code}"`);
      expect(text).toContain(`"status":${status}`);
      expect(text).not.toContain('"finish_reason":"stop"');
    });
  }
});

/** A vendor that answers 200 and then never sends a chunk. */
function headersThenSilence() {
  const s = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start() {
            /* headers flushed, no chunk, no close */
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  servers.push(s);
  return { origin: `http://127.0.0.1:${s.port}` };
}

describe("half-open streams", () => {
  test("a vendor that never sends a byte is a 504 首字节超时", async () => {
    // `fetch` only resolves on the first byte, so a vendor that sends nothing
    // lands on the first-byte watchdog rather than the iterator's branches.
    // Pin the status: magpie fails over on 5xx, and silence must never read
    // as a client cancel or a business error.
    const { origin } = headersThenSilence();
    const c = new DongleyaClient({
      origin,
      token: "t",
      firstByteTimeoutMs: 25,
      idleTimeoutMs: 5000,
    });

    // The abort can land before or after `fetch` resolves on headers, so the
    // assertion covers both entry points.
    const err = await (async () => {
      const { events } = await c.chatStream(BODY);
      for await (const _ of events) {
        /* drain */
      }
    })().then(
      () => null,
      (e) => e,
    );

    expect(err?.status).toBe(504);
    expect(err?.message).toContain("首字节");
  });

  test("a hang-up still stops the vendor run", async () => {
    // The id is captured at the gate, before the stream reaches magpie.
    // It used to be learned from the loop instead, which the cancel tears
    // down — so a hang-up dropped the connection and left the generation
    // billing server-side.
    let aborted = null;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });

    const client = {
      async chatStream() {
        return {
          res: new Response(null, { status: 200 }),
          events: {
            [Symbol.asyncIterator]() {
              let served = 0;
              return {
                async next() {
                  served += 1;
                  if (served === 1) {
                    return { done: false, value: { type: "session-created", sessionId: "s_late" } };
                  }
                  await gate; // park until the test has cancelled
                  return { done: true, value: undefined };
                },
                async return() {
                  return { done: true, value: undefined };
                },
              };
            },
          },
          abort() {},
        };
      },
      async abortChat(id) {
        aborted = id;
      },
    };

    const res = await handleChatCompletion(client, { token: "t", userId: "u" }, {}, {
      ...BODY,
      stream: true,
    });

    await res.body.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe("s_late");
    release();
  });
});

describe("error vocabulary", () => {
  // ERROR-CODES §3, v1. Frozen: a plugin may not invent its own words, and
  // magpie routes on `status` alone — a code outside this set is a code no
  // agent can branch on.
  const FROZEN = new Set([
    "sign_in_required",
    "session_expired",
    "audit_blocked",
    "invalid_request",
    "model_not_found",
    "concurrency_conflict",
    "rate_limited",
    "upstream_unavailable",
    "upstream_timeout",
    "upstream_error",
    "internal_error",
    "not_implemented",
  ]);

  test("every error class maps into the frozen set", () => {
    const cases = [
      new AuthExpiredError(),
      new RateLimitedError("slow"),
      new InviteRequiredError(),
      new ModelNotFoundError("x", []),
      new ContentFilterError(),
      new InsufficientCreditsError(),
      new ClientRejectedError(),
      // Carrying the vendor's own business code is the shape that used to
      // leak it into `code` by passthrough.
      new UpstreamError("x", { status: 502, code: 20003, codeName: "FORBIDDEN" }),
      new InvalidInputError("x", { code: 10001, codeName: "INVALID_INPUT" }),
      new RateLimitedError("x", { code: 13000, retryAfterSec: 3 }),
      new StreamFrameError("x"),
      new StreamFrameError("x", { kind: "busy" }),
      new StreamFrameError("x", { kind: "model-rejected" }),
      new GatewayError(500, "x", "upstream_error"),
      new Error("unknown"),
    ];

    for (const err of cases) {
      const code = errorCode(err, errorStatus(err));
      expect(FROZEN.has(code), `${err.name} -> ${code}`).toBe(true);
    }
  });

  test("the envelope carries status and never a numeric code", async () => {
    // The vendor's own business code (`20003`, `MODEL_BUSY`) used to leak
    // into `code` by passthrough. It is not a word anybody branches on.
    const body = await openaiError(502, "x").json();

    expect(body.error.status).toBe(502);
    expect(typeof body.error.code).toBe("string");
    expect(FROZEN.has(body.error.code)).toBe(true);
  });
});

describe("redirects", () => {
  test("a redirect is refused, not followed with the bearer token", async () => {
    // `fetch` defaults to `redirect: "follow"`, and the credential here is a
    // header — following a 3xx hands it to whatever host the Location names.
    // The vendor has no reason to redirect an API call, so a 3xx is refused
    // outright, and the second origin must never see a request.
    let reached = 0;
    const sink = Bun.serve({
      port: 0,
      fetch() {
        reached += 1;
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    servers.push(sink);

    const edge = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${sink.port}/steal` },
        });
      },
    });
    servers.push(edge);

    const c = new DongleyaClient({
      origin: `http://127.0.0.1:${edge.port}`,
      token: "secret",
    });

    const err = await c.me("secret").then(
      () => null,
      (e) => e,
    );

    expect(err?.status).toBe(502);
    expect(err?.message).toContain("重定向");
    expect(reached).toBe(0);
  });
});
