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
import { DongleyaClient, UpstreamError } from "../src/dongleya.mjs";
import { handleChatCompletion } from "../src/gateway.mjs";
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
  for (const [stopReason, code] of [
    ["content_filter", "CONTENT_FILTER"],
    ["insufficient_credits", "INSUFFICIENT_CREDITS"],
    ["model_stalled", "MODEL_STALLED"],
    ["error", "CHAT_REQUEST_FAILED"],
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
      expect(text).not.toContain('"finish_reason":"stop"');
    });
  }
});
