// test/stream.test.js — the vendor's `data: ` framing and the OpenAI mapping.
import { describe, test, expect } from "bun:test";
import { parseEventStream } from "../src/dongleya.mjs";
import { toVendorMessages, toVendorBody, resolveModel, errorStatus, normalizeEffort } from "../src/gateway.mjs";
import {
  AuthExpiredError,
  InviteRequiredError,
  InsufficientCreditsError,
  ContentFilterError,
  ModelNotFoundError,
  RateLimitedError,
  StreamFrameError,
  UpstreamError,
  ClientRejectedError,
  InvalidInputError,
} from "../src/dongleya.mjs";

const ENC = new TextEncoder();

/** Build a `data: {...}\n\n` framed body from objects. */
function frame(events) {
  return new Blob([events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")]).stream();
}

async function collect(stream) {
  const out = [];
  for await (const ev of parseEventStream(stream)) out.push(ev);
  return out;
}

describe("parseEventStream", () => {
  test("splits on blank lines and parses JSON payloads", async () => {
    const body = frame([
      { type: "session-created", sessionId: "s1" },
      { type: "text-delta", delta: "你" },
      { type: "finish", stopReason: "completed" },
    ]);
    expect(await collect(body)).toEqual([
      { type: "session-created", sessionId: "s1" },
      { type: "text-delta", delta: "你" },
      { type: "finish", stopReason: "completed" },
    ]);
  });

  test("tolerates CRLF and a trailing block with no separator", async () => {
    const body = new Blob([
      `data: {"type":"text-delta","delta":"a"}\r\n\r\ndata: {"type":"finish","stopReason":"completed"}`,
    ]).stream();
    const got = await collect(body);
    expect(got.map((e) => e.type)).toEqual(["text-delta", "finish"]);
  });

  test("skips malformed frames instead of throwing", async () => {
    const body = new Blob([`data: not-json\n\ndata: {"type":"text-delta","delta":"ok"}\n\n`]).stream();
    expect(await collect(body)).toEqual([{ type: "text-delta", delta: "ok" }]);
  });

  test("ignores [DONE] and non-data lines", async () => {
    const body = new Blob([`event: x\n\ndata: [DONE]\n\ndata: {"type":"finish","stopReason":"completed"}\n\n`]).stream();
    expect((await collect(body)).length).toBe(1);
  });

  test("reassembles a frame split across chunk boundaries", async () => {
    const parts = [`data: {"type":"text-`, `delta","delta":"split"}\n\n`];
    const rs = new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(ENC.encode(p));
        c.close();
      },
    });
    expect(await collect(rs)).toEqual([{ type: "text-delta", delta: "split" }]);
  });
});

describe("toVendorMessages", () => {
  test("splices system into the first user turn", () => {
    const { messages } = toVendorMessages([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    expect(messages).toEqual([{ role: "user", content: "be terse\n\nhi" }]);
  });

  test("merges consecutive same-role turns", () => {
    const { messages } = toVendorMessages([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ]);
  });

  test("flattens content-part arrays to text", () => {
    const { messages } = toVendorMessages([
      { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
    ]);
    expect(messages[0].content).toBe("one\ntwo");
  });

  test("drops a trailing assistant turn and a leading assistant turn", () => {
    expect(
      toVendorMessages([
        { role: "assistant", content: "stale" },
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ]).messages,
    ).toEqual([{ role: "user", content: "q" }]);
  });

  test("rejects an empty message list and an assistant-only list", () => {
    expect(() => toVendorMessages([])).toThrow();
    expect(() => toVendorMessages([{ role: "assistant", content: "x" }])).toThrow();
  });
});

describe("model + body shaping", () => {
  test("resolveModel picks the catalog entry case-insensitively", () => {
    const models = [{ id: "glm-5.3" }, { id: "kimi-k3.1-pro" }];
    expect(resolveModel("Kimi-K3.1-Pro", models)).toBe("kimi-k3.1-pro");
    expect(resolveModel("", models)).toBe("auto");
  });

  test("resolveModel throws for an unknown id when a catalog exists", () => {
    expect(() => resolveModel("nope", [{ id: "glm-5.3" }])).toThrow(ModelNotFoundError);
  });

  test("resolveModel degrades to the requested id with no catalog", () => {
    expect(resolveModel("whatever", [])).toBe("whatever");
  });

  test("toVendorBody carries only the fields the vendor reads", () => {
    const body = toVendorBody({
      messages: [{ role: "user", content: "hi" }],
      model: "auto",
      reasoningEffort: "high",
      lang: "en",
    });
    expect(body).toEqual({
      messages: [{ role: "user", content: "hi" }],
      lang: "en",
      extra: {
        model: "auto",
        modelUiId: "auto",
        modelSelectionSource: "api",
        modelFromUiClick: false,
        reasoningEffort: "high",
      },
    });
  });

  test("normalizeEffort maps the OpenAI vocabulary", () => {
    expect(normalizeEffort("minimal")).toBe("low");
    expect(normalizeEffort("MAX")).toBe("max");
    expect(normalizeEffort("")).toBe("");
    expect(normalizeEffort(undefined)).toBe("");
  });
});

describe("errorStatus", () => {
  test("maps each vendor failure to the right OpenAI status", () => {
    expect(errorStatus(new AuthExpiredError())).toBe(401);
    expect(errorStatus(new ModelNotFoundError("x", []))).toBe(404);
    expect(errorStatus(new ContentFilterError())).toBe(400);
    // 402 is not in the host's table: credits are an account wall, and
    // another account clears it, which is what 502 tells magpie to try.
    expect(errorStatus(new InsufficientCreditsError())).toBe(502);
    expect(errorStatus(new RateLimitedError("slow"))).toBe(429);
    // 401 + `X-Magpie-Sign-In: kept` — an access problem, but the session is
    // alive, so magpie must not offer a re-sign-in that cannot fix it.
    expect(errorStatus(new InviteRequiredError())).toBe(401);
    expect(errorStatus(new StreamFrameError("busy", { kind: "busy" }))).toBe(503);
    // 404 shelves just this model; 403 is unknown to the host and retries.
    expect(errorStatus(new StreamFrameError("bad", { kind: "model-rejected" }))).toBe(404);
    // Verified-live codes: the UA gate is a stale fingerprint (502), not a
    // permission or auth problem (403/401) — re-login must not be offered.
    expect(errorStatus(new ClientRejectedError())).toBe(502);
    expect(errorStatus(new InvalidInputError())).toBe(400);
    expect(errorStatus(new UpstreamError("x", { status: 502 }))).toBe(502);
    expect(errorStatus(new Error("unknown"))).toBe(502);
  });
});
