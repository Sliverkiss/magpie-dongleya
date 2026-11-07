// test/live.test.js — contract checks against the real dongleya.qq.com.
//
// These hit production, so they assert only things that are true for an
// unauthenticated caller: the public model catalog, the auth config, and the
// exact shape of the 401/200 error envelopes. Nothing here needs an account.
//
// Skipped by default (CI must not depend on the vendor being up):
//   bun test --test-name-pattern live   → runs them
// or DONGLEYA_LIVE=1 bun test
import { describe, test, expect } from "bun:test";
import {
  DongleyaClient,
  AuthExpiredError,
  InvalidInputError,
  ClientRejectedError,
  BROWSER_UA,
  ORIGIN,
} from "../src/dongleya.mjs";

const LIVE = process.env.DONGLEYA_LIVE === "1";

describe("live contract", () => {
  const c = new DongleyaClient();

  test.skipIf(!LIVE)("public model catalog parses into rows", async () => {
    const payload = await c.models();
    expect(Array.isArray(payload.models)).toBe(true);
    expect(payload.models.length).toBeGreaterThan(5);
    // `auto` is the vendor's own default and must always be offered.
    expect(payload.models.some((m) => m.id === "auto")).toBe(true);
    for (const m of payload.models) {
      expect(typeof m.id).toBe("string");
      if (m.reasoningEfforts !== undefined) {
        expect(Array.isArray(m.reasoningEfforts)).toBe(true);
        for (const e of m.reasoningEfforts) expect(["low", "medium", "high", "max"]).toContain(e);
      }
    }
  });

  test.skipIf(!LIVE)("auth config reports the SMS route as available", async () => {
    const cfg = await c.authConfig();
    expect(cfg.smsAuthEnabled).toBe(true);
    // The notes claim password login is off; if the vendor ever turns it on,
    // a username/password method becomes worth adding.
    expect(cfg.passwordAuthEnabled).toBe(false);
  });

  test.skipIf(!LIVE)("a garbage JWT is an AuthExpiredError, not a 502", async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "");
    const fake = `${b64({ alg: "HS256" })}.${b64({ userId: "x", exp: 9999999999 })}.sig`;
    let err;
    try {
      await c.credits(fake);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthExpiredError);
  });

  test.skipIf(!LIVE)("chat without a token is an AuthExpiredError", async () => {
    let err;
    try {
      await c.chatStream({ messages: [{ role: "user", content: "hi" }], lang: "zh" }, { token: "" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthExpiredError);
  });

  test.skipIf(!LIVE)("a number the vendor will not text yields InvalidInputError with a reason", async () => {
    // All-zero is rejected by the vendor's own validator; no SMS is sent.
    let err;
    try {
      await c.sendVerifyCode("00000000000");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.reason).toBeTruthy();
  });

  test.skipIf(!LIVE)("/api/models is fully public — no token, no browser UA", async () => {
    // Verified live: unlike /api/v3/chat, the catalog endpoint has no client
    // gate at all. If that ever changes, the plugin's pre-login model list
    // breaks and this catches it.
    const res = await fetch(`${ORIGIN}/api/models`, { headers: { "user-agent": "curl/8.0" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.models)).toBe(true);
  });

  test.skipIf(!LIVE)("the chat endpoint gates on UA before token, and we classify it", async () => {
    // Same request, non-browser UA: the edge rejects the client, not the
    // credential. The plugin must report this as a stale-fingerprint fault
    // (502) rather than an expired session (401) — re-login cannot fix it.
    const res = await fetch(`${ORIGIN}/api/v3/chat`, {
      method: "POST",
      headers: { "user-agent": "curl/8.0", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], lang: "zh" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.codeName).toBe("FORBIDDEN");
    expect(body.message).toBe("Invalid client");
  });

  test.skipIf(!LIVE)("with the browser UA the same request is a plain auth failure", async () => {
    const res = await fetch(`${ORIGIN}/api/v3/chat`, {
      method: "POST",
      headers: { "user-agent": BROWSER_UA, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], lang: "zh" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.codeName).toBe("UNAUTHORIZED");
  });

  test.skipIf(!LIVE)("the UA gate is classified as ClientRejectedError, not AuthExpiredError", async () => {
    // Drive it through the real client so the classify() chain is what is
    // under test, not a hand-rolled fetch.
    const bad = new DongleyaClient({ origin: ORIGIN });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) =>
      realFetch(url, { ...init, headers: { ...init.headers, "user-agent": "curl/8.0" } });
    let err;
    try {
      await bad.chatStream({ messages: [{ role: "user", content: "hi" }], lang: "zh" }, { token: "" });
    } catch (e) {
      err = e;
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(err).toBeInstanceOf(ClientRejectedError);
  });
});
