// test/plugin.test.js — the whole plugin against a mock 懂了鸭: SMS login,
// the chat completion round trip, streaming, and the error paths magpie cares
// about. The mock speaks the real wire shapes (JWT, `data:` framing, the
// {code, codeName} error envelope) so a shape drift here is a real regression.
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DongleyaAuthPlugin } from "../index.mjs";
import { accessOf, inviteMessage } from "../src/dongleya.mjs";
import { readInvite, writeInvite, codeForAccount } from "../src/invite.mjs";

// Never let the suite touch the real invite cache: settleAccess() writes to it
// on every login, and a test run must not rotate the code a user will be
// handed next. Point the module at a scratch dir for the whole file.
const SUITE_CACHE = mkdtempSync(join(tmpdir(), "dly-suite-"));
process.env.DONGLEYA_CACHE_DIR = SUITE_CACHE;

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

/** A JWT with a real-looking payload so the plugin's decode path runs. */
function makeJwt({ userId = "u_42", exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ userId, exp, iat: 1 })}.sig`;
}

const MODELS = {
  models: [
    { id: "auto", provider: "Auto" },
    { id: "glm-5.3-flashx", provider: "GLM", reasoningEfforts: ["low", "high", "max"], costMultiplier: 2.1 },
    { id: "hy4", provider: "Hunyuan", reasoningEfforts: ["low", "medium", "high", "max"], costMultiplier: 1.58 },
  ],
  defaultModel: "auto",
};

/**
 * @param {object} opts
 *   chatStatus  — HTTP status for /api/v3/chat (default 200)
 *   chatBody    — override chat response body for the non-200 case
 *   events      — the `data:` frames to stream
 *   invite      — answer chat with an in-band INVITE_REQUIRED error
 *   deadToken   — /api/auth/me answers 401
 */
function mockVendor(opts = {}) {
  const seen = [];
  const redeems = [];  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      seen.push({ path: u.pathname, method: req.method, body, headers: req.headers });

      const json = (o, status = 200, extraHeaders) =>
        new Response(JSON.stringify({ code: 0, codeName: "", ...o }), {
          status,
          headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
        });

      switch (u.pathname) {
        case "/api/auth/sms/send-code":
          return json({ success: true });

        case "/api/auth/sms/verify-code": {
          if (body.code !== "123456") {
            return json({ code: 40001, codeName: "INVALID_CODE", message: "验证码不正确" }, 200);
          }
          return json({ success: true, token: makeJwt(), user: { userId: "u_42", phone: body.phone } });
        }

        case "/api/auth/me":
          if (opts.deadToken) return json({ codeName: "UNAUTHORIZED", message: "token expired" }, 401);
          if (opts.gated || opts.gate) {
            // Stateful like the real gate: opening it is what flips
            // accessGranted, and only a successful redeem does that.
            const gated = opts.gate ? !opts.gate.redeemed : true;
            return json({
              success: true,
              data: {
                user: { id: "51bb8428", nickname: "4616" },
                accessGranted: !gated,
                inviteOnly: true,
                onboardingCompleted: false,
                application: gated ? { status: "pending" } : null,
              },
            });
          }
          return json({ success: true, user: { userId: "u_42", phone: "13800138000", nickname: "鸭友" } });

        case "/api/access/redeem-invite": {
          const want = opts.gate?.require;
          if (!want) return json({ codeName: "NOT_FOUND" }, 404);
          if (String(body.code || "").trim().toUpperCase() !== String(want).toUpperCase()) {
            redeems.push(body.code);
            return json({ success: false, message: "邀请码无效", code: 10010, codeName: "INVITE_INVALID" });
          }
          redeems.push(body.code);
          opts.gate.redeemed = body.code;
          return json({ success: true, data: { code: body.code, kind: "referral", rewarded: true } });
        }

        case "/api/referral/me":
          return json({ success: true, data: { code: opts.gate?.own || "QGFR9R", inviteUrl: "https://x/?ref=Q", inviteCount: 0 } });

        case "/api/models":
          if (opts.modelsStatus && opts.modelsStatus !== 200) {
            return json({ codeName: "INTERNAL", message: "boom" }, opts.modelsStatus);
          }
          return json(MODELS);

        case "/api/credits":
          if (opts.deadToken) return json({ codeName: "UNAUTHORIZED", message: "token expired" }, 401);
          if (opts.stringBalance)
            return json({
              success: true,
              data: { balance: "489.69", creationCredits: { available: "489.69" }, eggs: { balance: "5" } },
            });
          return json({
            success: true,
            data: {
              // Live shape: `balance` is the aggregate and the ledger only
              // has one credit bucket, so this equals creationCredits.
              // available. Keep them equal or the suite can't see a
              // duplicated row.
              balance: 128,
              totalGifted: 500,
              totalUsed: 372,
              totalPurchased: 0,
              creationCredits: { available: 128, expiresAt: 1767225600000 },
              downloadQuota: { available: 10, expiresAt: 1767225600000 },
              watermarkQuota: { available: 0, expiresAt: null },
              eggs: { balance: 9 },
              eggBalance: 9,
              hasActiveMembership: true,
              membershipTier: "advanced",
            },
          });

        case "/api/credits/checkin":
          return json({
            success: true,
            data: opts.alreadyChecked
              ? { alreadyCheckedIn: true, credits: 0 }
              : { alreadyCheckedIn: false, credits: 5, creationCredits: 2 },
          });

        case "/api/v3/chat": {
          if (opts.chatStatus && opts.chatStatus !== 200) {
            // The vendor's 429 is meaningless without this header, so the
            // mock has to carry it or the plugin's parsing is untested.
            const headers = opts.chatRetryAfter ? { "retry-after": opts.chatRetryAfter } : undefined;
            return json(
              opts.chatBody ?? { codeName: "MODEL_BUSY", message: "模型忙" },
              opts.chatStatus,
              headers,
            );
          }
          const frames = opts.invite
            ? [{ type: "error", code: "INVITE_REQUIRED", message: "需要邀请才能使用" }]
            : (opts.events ?? [
                { type: "session-created", isNew: true, sessionId: "sess-1" },
                { type: "reasoning-delta", delta: "想一下" },
                { type: "text-delta", delta: "你好" },
                { type: "text-delta", delta: "，鸭。" },
                { type: "finish", stopReason: "completed" },
              ]);
          const wire = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
          return new Response(wire, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        default:
          return json({ codeName: "NOT_FOUND" }, 404);
      }
    },
  });
  servers.push(server);
  return { server, origin: `http://127.0.0.1:${server.port}`, seen, redeems };
}

/** Wire up the plugin the way magpie does: a getAuth closure over one account. */
async function bootPlugin(origin, extraOptions, options = new Set()) {
  let saved = null;
  // `input.magpie.option(provider, key)` is how the host surfaces a Plugin
  // option; `options` is the set of keys switched on.
  const magpie = { option: (provider, key) => provider === "dongleya" && options.has(key) };
  const plugin = await DongleyaAuthPlugin({ client: {}, magpie }, { origin, ...extraOptions });
  const getAuth = async () => saved;
  const setAuth = (a) => {
    saved = a;
  };
  return { plugin, getAuth, setAuth };
}

/** Complete the SMS login method end to end and return the saved session. */
async function login(plugin, phone = "13800138000") {
  const method = plugin.auth.methods[0];
  const first = await method.authorize({ phone });
  expect(first.method).toBe("code");
  const saved = await first.callback("123456");
  expect(saved.type).toBe("success");
  return saved;
}

describe("login", () => {
  test("SMS login returns an oauth-shaped session with a decoded userId", async () => {
    const { origin } = mockVendor();
    const { plugin } = await bootPlugin(origin);

    const saved = await login(plugin);
    expect(saved.token.split(".").length).toBe(3);
    expect(saved.access).toBe(saved.token);
    expect(saved.refresh).toBe(saved.token);
    expect(saved.userId).toBe("u_42");
    expect(saved.phone).toBe("13800138000");
    expect(saved.expires).toBeGreaterThan(Date.now());
    expect(saved.label).toBe("鸭友");
    expect(saved.accountId).toBe("鸭友");
  });

  test("a wrong code surfaces as a failed login, not a thrown error", async () => {
    const { origin } = mockVendor();
    const { plugin } = await bootPlugin(origin);
    const first = await plugin.auth.methods[0].authorize({ phone: "13800138000" });
    const r = await first.callback("000000");
    expect(r.type).toBe("failed");
    expect(r.error).toContain("验证码不正确");
  });

  test("a malformed phone is rejected before any request is made", async () => {
    const { origin, seen } = mockVendor();
    const { plugin } = await bootPlugin(origin);
    let err;
    try {
      await plugin.auth.methods[0].authorize({ phone: "123" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(seen.length).toBe(0);
  });

  test("every login method declares prompts so magpie passes inputs", () => {
    // HOOKS.md 陷阱 2: a method with no prompts is called with `undefined`,
    // which would make authorize() throw on any input-taking method.
    const { origin } = mockVendor();
    return bootPlugin(origin).then(({ plugin }) => {
      for (const m of plugin.auth.methods) {
        expect(Array.isArray(m.prompts)).toBe(true);
        expect(m.prompts.length).toBeGreaterThan(0);
        for (const pr of m.prompts) {
          expect(typeof pr.key).toBe("string");
          expect(pr.key.length).toBeGreaterThan(0);
        }
      }
    });
  });

  test("token paste method accepts a JWT and rejects a non-JWT", async () => {
    const { origin } = mockVendor();
    const { plugin } = await bootPlugin(origin);
    const token = makeJwt();

    const ok = await plugin.auth.methods[1].authorize({ key: token });
    expect(ok.type).toBe("success");
    expect(ok.userId).toBe("u_42");

    let err;
    try {
      await plugin.auth.methods[1].authorize({ key: "not-a-jwt" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
  });

  test("refresh inside the lead window probes once and stops scheduling, not per request", async () => {
    // The JWT has no refresh token, so a pass cannot extend it. Returning the
    // same `expires` left magpie's `renewAt` in the past for the whole lead
    // window: every request, models, usage and checkin re-fired the /me
    // probe plus an auth-file lock and write. `expires: 0` after a passing
    // probe ends the loop; a token that dies early is still marked by the
    // loader's 401 (signIn:"expired").
    const { origin, seen } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    const saved = await login(plugin);

    // Login already consumed one /me; count from here.
    const meCalls = () => seen.filter((s) => s.path === "/api/auth/me").length;
    const before = meCalls();

    // A token entering the lead window: refresh runs, probes /me, passes.
    const due = { ...saved, token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 60 }) };
    due.access = due.refresh = due.token;
    setAuth(due);
    expect((await plugin.auth.refresh(await getAuth())).expires).toBe(0);

    // A still-fresh token is reported honestly, without probing.
    const fresh = { ...saved };
    setAuth(fresh);
    expect((await plugin.auth.refresh(await getAuth())).expires).toBeGreaterThan(Date.now());

    // One probe for the whole thing, not one per refresh call.
    expect(meCalls() - before).toBe(1);
  });
});

describe("chat completion", () => {
  test("non-streaming returns an OpenAI completion with content and reasoning", async () => {
    const { origin, seen } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    const res = await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "hy4",
        messages: [
          { role: "system", content: "简短回答" },
          { role: "user", content: "你好" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("你好，鸭。");
    expect(body.choices[0].message.reasoning_content).toBe("想一下");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBeGreaterThan(0);

    // The vendor must have received the system prompt spliced into turn one.
    const chat = seen.find((s) => s.path === "/api/v3/chat");
    expect(chat.body.messages).toEqual([{ role: "user", content: "简短回答\n\n你好" }]);
    expect(chat.body.extra.model).toBe("hy4");
    expect(chat.headers.get("authorization")).toStartWith("Bearer ");
    expect(chat.headers.get("user-agent")).toContain("Chrome");
  });

  test("streaming emits role, deltas, finish and a bare [DONE]", async () => {
    const { origin } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    const res = await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: [DONE]");
    // The terminator must be the bare literal, never a JSON string.
    expect(text).not.toContain('"[DONE]"');

    const frames = text
      .split("\n\n")
      .map((b) => b.trim())
      .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
      .map((b) => JSON.parse(b.slice(6)));

    expect(frames[0].choices[0].delta.role).toBe("assistant");
    const content = frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("");
    expect(content).toBe("你好，鸭。");
    const reasoning = frames.map((f) => f.choices?.[0]?.delta?.reasoning_content ?? "").join("");
    expect(reasoning).toBe("想一下");
    const last = frames[frames.length - 1];
    expect(last.usage.total_tokens).toBeGreaterThan(0);
  });

  test("reasoning effort reaches the vendor in extra.reasoningEffort", async () => {
    const { origin, seen } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "hy4", reasoning_effort: "max", messages: [{ role: "user", content: "q" }] }),
    });
    const chat = seen.find((s) => s.path === "/api/v3/chat");
    expect(chat.body.extra.reasoningEffort).toBe("max");
  });

  test("an unknown model is a 404, not a silent fallback", async () => {
    const { origin } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));
    await plugin.provider.models({}, { auth: await getAuth() }); // warm the catalog

    const loader = await plugin.auth.loader(getAuth);
    const res = await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "does-not-exist", messages: [{ role: "user", content: "q" }] }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toContain("does-not-exist");
  });

  test("a dead session throws signIn:expired so magpie can mark the account", async () => {
    const { origin } = mockVendor({ chatStatus: 401, chatBody: { codeName: "UNAUTHORIZED", message: "expired" } });
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    let err;
    try {
      await loader.fetch("http://x/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "q" }] }),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.signIn).toBe("expired");
  });

  // Both paths, because the gate lives in whichever branch runs. The
  // streaming branch used to place its check after `new ReadableStream(...)`,
  // whose `start` is called synchronously and returns at the first `await` —
  // so the check always saw `firstEvent === null`, and a gated account came
  // back as HTTP 200 with an error frame inside. magpie cannot mark an
  // account from a frame, so it retried the dead session every turn.
  for (const stream of [false, true]) {
    test(`the invite gate is a 403 and never a signIn:expired (stream=${stream})`, async () => {
      const { origin } = mockVendor({ invite: true });
      const { plugin, getAuth, setAuth } = await bootPlugin(origin);
      setAuth(await login(plugin));

      const loader = await plugin.auth.loader(getAuth);
      const res = await loader.fetch("http://x/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "auto", stream, messages: [{ role: "user", content: "q" }] }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.message).toContain("邀请");
    });
  }

  // A clean EOF with no `finish` frame is a truncated generation — the vendor
  // died, a proxy drained, a server-side abort skipped the frame. Nothing
  // throws on it, so both paths used to hand the client a cut answer marked
  // as a clean stop, at full price.
  for (const stream of [false, true]) {
    test(`EOF before finish is an error, not a short answer (stream=${stream})`, async () => {
      const { origin } = mockVendor({
        events: [
          { type: "session-created", isNew: true, sessionId: "sess-1" },
          { type: "text-delta", delta: "半句" },
        ],
      });
      const { plugin, getAuth, setAuth } = await bootPlugin(origin);
      setAuth(await login(plugin));

      const loader = await plugin.auth.loader(getAuth);
      const res = await loader.fetch("http://x/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "auto", stream, messages: [{ role: "user", content: "q" }] }),
      });

      if (!stream) {
        expect(res.status).toBe(502);
        expect((await res.json()).error.code).toBe("STREAM_TRUNCATED");
        return;
      }
      // Streaming: headers are long gone, so the truncation has to arrive as
      // an error frame rather than a clean `stop`.
      const frames = (await res.text())
        .split("\n\n")
        .map((b) => b.trim())
        .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
        .map((b) => JSON.parse(b.slice(6)));
      const bad = frames.find((f) => f.error);
      expect(bad.error.code).toBe("STREAM_TRUNCATED");
      expect(frames.some((f) => f.choices?.[0]?.finish_reason === "stop")).toBe(false);
    });
  }

  test("a cancelled stream aborts the vendor session instead of billing for it", async () => {
    const { origin, seen } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    const res = await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "q" }] }),
    });
    // Hang up the way a client does: cancel the body, don't read it.
    await res.body.cancel();
    // abortChat is fire-and-forget; give the microtask queue a beat.
    await new Promise((r) => setTimeout(r, 50));

    const aborted = seen.filter((s) => s.path === "/api/v3/chat/abort");
    expect(aborted.length).toBe(1);
    expect(aborted[0].body.sessionId).toBe("sess-1");
  });

  test("offered tools are rendered into the prompt, not refused", async () => {
    const { origin, seen } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    const res = await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "q" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      }),
    });
    // magpie advertises `tool_call: true` on every chat model it lists
    // (`toolsTold`), so a 400 here is every agent turn. The vendor has no
    // `tools` field; the tools ride the prompt instead, in the `<tool_call>`
    // shape magpie's `textCallTidy` lifts back into a real call.
    expect(res.status).toBe(200);

    const sent = seen.find((s) => s.path === "/api/v3/chat").body;
    expect(sent.tools).toBeUndefined();
    const prompt = sent.messages[0].content;
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("read a file");
    expect(prompt).toContain("<tool_call>");
    expect(prompt).toContain('"path"');
  });

  test("tool_choice: none drops the tool instructions", async () => {
    const { origin, seen } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "q" }],
        tool_choice: "none",
        tools: [{ type: "function", function: { name: "read_file" } }],
      }),
    });
    // The caller forbade calls; with no tools in the prompt the model has
    // nothing to call, which is what "none" means.
    const sent = seen.find((s) => s.path === "/api/v3/chat").body;
    expect(sent.messages[0].content).not.toContain("read_file");
  });

  test("tool_use and tool_result turns survive the round trip as text", async () => {
    const { origin, seen } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "auto",
        tools: [{ type: "function", function: { name: "read_file" } }],
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "file body" },
        ],
      }),
    });

    const sent = seen.find((s) => s.path === "/api/v3/chat").body;
    // The vendor only knows user/assistant, and it must see the call it made
    // and the result that came back — a transcript with those turns dropped is
    // what made the model continue a conversation that never happened.
    const roles = sent.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(sent.messages[1].content).toContain('<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>');
    expect(sent.messages[1].content.startsWith("\n")).toBe(false);
    expect(sent.messages[2].content).toBe('<tool_result tool_call_id="c1">file body</tool_result>');
  });

  // `Number(res.headers.get("retry-after"))` is the trap here: `get` returns
  // `null` when the header is absent, `Number(null)` is 0, and
  // `Number.isFinite(0)` is true — so the "no opinion" branch never fires and
  // every 429 carried `retryAfterSec: 0`. magpie backs off zero seconds,
  // re-fires into the limit, and repeats until the account is banned.
  const rateLimitCases = [
    ["no header", undefined, undefined],
    ["delta seconds", "7", 7],
    ["an HTTP date in the future", new Date(Date.now() + 30_000).toUTCString(), 30],
    ["a date in the past", new Date(Date.now() - 30_000).toUTCString(), undefined],
    ["garbage", "soon", undefined],
  ];
  for (const [label, header, want] of rateLimitCases) {
    test(`429 retry-after: ${label}`, async () => {
      const { origin } = mockVendor({ chatStatus: 429, chatRetryAfter: header });
      const { plugin, getAuth, setAuth } = await bootPlugin(origin);
      setAuth(await login(plugin));

      const loader = await plugin.auth.loader(getAuth);
      const res = await loader.fetch("http://x/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "q" }] }),
      });
      expect(res.status).toBe(429);
      // An HTTP date is second-precision and the case is stamped when the
      // array is built, so `Math.ceil((at - Date.now()) / 1000)` runs a beat
      // later than the 30 it was written as. Time only moves forward, so the
      // header is at most `want` and never more than a couple of seconds
      // under it — pinning it to exactly `want` is a coin flip on how long
      // login() takes.
      if (want === undefined) expect(res.headers.get("retry-after")).toBeNull();
      else {
        const got = Number(res.headers.get("retry-after"));
        expect(got).toBeLessThanOrEqual(want);
        expect(got).toBeGreaterThanOrEqual(want - 2);
      }
    });
  }

  test("a 503 MODEL_BUSY maps to 503 so magpie can fail over", async () => {
    const { origin } = mockVendor({ chatStatus: 503, chatBody: { codeName: "MODEL_BUSY" } });
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const loader = await plugin.auth.loader(getAuth);
    const res = await loader.fetch("http://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "q" }] }),
    });
    expect(res.status).toBe(503);
  });
});

describe("invite chain (login redeems, then publishes)", () => {
  let scratch;
  const setCache = () => {
    scratch = mkdtempSync(join(tmpdir(), "dly-cache-"));
    process.env.DONGLEYA_CACHE_DIR = scratch;
    return scratch;
  };
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    // Restore, never delete: an unset var would send the next test's login
    // writes into the user's real ~/.cache/magpie.
    process.env.DONGLEYA_CACHE_DIR = SUITE_CACHE;
  });

  test("a gated login redeems the author's code and ends up granted", async () => {
    setCache();
    const { origin, redeems } = mockVendor({ gate: { require: "RMLM4C", own: "QGFR9R" } });
    const { plugin } = await bootPlugin(origin);
    const saved = await login(plugin);

    expect(saved.type).toBe("success");
    expect(redeems).toEqual(["RMLM4C"]);
    const me = await plugin.auth.usage(async () => saved);
    // Gate opened, so the card no longer leads with 准入状态.
    expect(me.windows[0].name).not.toBe("准入状态");
  });

  test("the account's own code becomes what the next login redeems", async () => {
    setCache();
    // Account 1 gets in on the author's code and publishes QGFR9R.
    const a = mockVendor({ gate: { require: "RMLM4C", own: "QGFR9R" } });
    await login((await bootPlugin(a.origin)).plugin);
    expect(readInvite()).toBe("QGFR9R");

    // Account 2 is a *different* account on the same machine: the only code it
    // will accept is account 1's. Using the author's code here would still
    // redeem successfully, so the assertion is on what was actually sent.
    const b = mockVendor({ gate: { require: "QGFR9R", own: "NEWC02" } });
    await login((await bootPlugin(b.origin)).plugin);
    expect(b.redeems).toEqual(["QGFR9R"]);
    // ...and account 2 in turn becomes the source for account 3.
    expect(readInvite()).toBe("NEWC02");
  });

  test("a rejected rolling code is dropped so the fallback is retried next time", async () => {
    setCache();
    writeInvite("DEAD01");
    const { origin, redeems } = mockVendor({ gate: { require: "RMLM4C" } });
    const { plugin } = await bootPlugin(origin);
    const saved = await login(plugin);

    // Login still succeeds — the account is real even when the gate stays shut.
    expect(saved.type).toBe("success");
    expect(redeems).toEqual(["DEAD01"]);
    expect(readInvite()).toBe("");
  });

  test("a granted account publishes its code without redeeming anything", async () => {
    setCache();
    const { origin, redeems } = mockVendor({});
    const { plugin } = await bootPlugin(origin);
    await login(plugin);

    expect(redeems).toEqual([]);
    expect(readInvite()).toBe("QGFR9R");
  });

  test("invite_fixed pins the code instead of rolling it", async () => {
    setCache();
    const { origin } = mockVendor({});
    const { plugin } = await bootPlugin(origin, undefined, new Set(["invite_fixed"]));
    const saved = await login(plugin);

    // A granted account still records its own code, but the rolling pointer
    // — the thing the next login reads — must not move.
    expect(readInvite()).toBe("");
    expect(codeForAccount(saved.accountId)).toBe("QGFR9R");
  });

  // The host validates option keys against /^[a-z0-9_-]{1,40}$/ and silently
  // drops any that fail. A camelCase key is a switch that never renders and
  // an optionOn() that is permanently false, with nothing to show for it.
  test("declared option keys are the ones the host accepts", async () => {
    const { origin } = mockVendor({});
    const { plugin } = await bootPlugin(origin);
    const keys = plugin.auth.options.map((o) => o.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_-]{1,40}$/);
  });
});

describe("invite gate", () => {
  // Verified live against a freshly registered account: /api/auth/me answers
  // success:true with accessGranted:false, and only the first chat turn fails.
  test("accessOf reads the gate out of /api/auth/me", () => {
    expect(accessOf({ data: { accessGranted: true, inviteOnly: true } })).toEqual({ granted: true });
    expect(accessOf({ data: { accessGranted: false, inviteOnly: true } })).toMatchObject({
      granted: false,
      inviteOnly: true,
    });
    // A payload that never mentions the field must not read as denied.
    expect(accessOf({ data: { user: {} } })).toEqual({ granted: true });
    expect(accessOf(null)).toEqual({ granted: true });
  });

  test("accessOf carries the application status when one exists", () => {
    const a = accessOf({ data: { accessGranted: false, application: { status: "pending" } } });
    expect(a.application).toBe("pending");
  });

  test("inviteMessage explains how to get in and never echoes the raw code", () => {
    const m = inviteMessage("INVITE_REQUIRED");
    expect(m).toContain("邀请");
    expect(m).not.toContain("[INVITE_REQUIRED]");
    // A vendor-supplied detail is kept, bracketed, so it is not lost.
    expect(inviteMessage("审核中")).toContain("[审核中]");
  });

  test("usage leads with the closed gate instead of a healthy balance", async () => {
    const { origin } = mockVendor({ gated: true });
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const u = await plugin.auth.usage(getAuth);
    expect(u.windows[0].name).toBe("准入状态");
    expect(u.windows[0].display).toContain("待审批");
  });
});

describe("account surfaces", () => {
  test("usage shows one credit balance, a real ceiling, and no invented used", async () => {
    const { origin } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const u = await plugin.auth.usage(getAuth);
    expect(u.balance).toBe("128 积分");
    expect(u.plan).toContain("advanced");

    const byName = (n) => u.windows.find((w) => w.name === n);

    // 积分余额 and 创作积分 are the same counter (one ledger bucket), so
    // showing both implies two wallets that don't exist.
    expect(byName("创作积分")).toBeUndefined();

    // A prepaid wallet is expressed as balance + unit, which is also what
    // magpie ranks accounts by. `used` must be absent: 0 is a real "0%
    // consumed", not "unknown".
    const wallet = byName("积分余额");
    expect(wallet.balance).toBe(128);
    expect(wallet.unit).toBe("积分");
    expect(wallet.used).toBeUndefined();
    expect(wallet.aside).toBeFalsy();

    // The vendor does publish a ceiling — totalGifted — and it belongs on
    // the card as text ("372 / 500 积分"). `amount`/`limit` would make
    // magpie derive used = amount/limit*100 and chart a lifetime cumulative
    // pair as a window share: the curve climbs to 100% and never comes back
    // down, and the card shows a progress track for a total that isn't an
    // allowance.
    const spent = byName("累计消耗");
    expect(spent.display).toBe("372 / 500 积分");
    expect(spent.amount).toBeUndefined();
    expect(spent.limit).toBeUndefined();
    expect(spent.used).toBeUndefined();

    expect(byName("鸭蛋").display).toBe("9 鸭蛋");
    expect(byName("下载额度").display).toBe("10 次");
  });

  test("usage on a numeric-string balance does not render a spent account", async () => {
    // Number.isFinite("489.69") is false, and the old fallback was 0 — a
    // vendor that switched to strings would show a zero balance.
    const { origin } = mockVendor({ stringBalance: true });
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const u = await plugin.auth.usage(getAuth);
    expect(u.balance).toBe("489.69 积分");
  });

  test("usage on a dead token returns signIn:expired", async () => {
    const { origin } = mockVendor({ deadToken: true });
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth({ token: makeJwt(), userId: "u_42" });

    const u = await plugin.auth.usage(getAuth);
    expect(u.signIn).toBe("expired");
  });

  test("checkin reports claimed on a fresh day and done when already claimed", async () => {
    {
      const { origin } = mockVendor();
      const { plugin, getAuth, setAuth } = await bootPlugin(origin);
      setAuth(await login(plugin));
      const r = await plugin.auth.checkin(getAuth);
      expect(r.outcome).toBe("claimed");
      expect(r.credit).toBe(7);
    }
    while (servers.length) servers.pop().stop(true);
    {
      const { origin } = mockVendor({ alreadyChecked: true });
      const { plugin, getAuth, setAuth } = await bootPlugin(origin);
      setAuth(await login(plugin));
      const r = await plugin.auth.checkin(getAuth);
      expect(r.outcome).toBe("done");
    }
  });

  test("provider.models returns the live catalog", async () => {
    const { origin } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));

    const models = await plugin.provider.models({}, { auth: await getAuth() });
    expect(Object.keys(models).sort()).toEqual(["auto", "glm-5.3-flashx", "hy4"]);
    // hy4 has 4 efforts, so its variants must be exposed; auto has none.
    expect(Object.keys(models.hy4.variants).sort()).toEqual(["high", "low", "medium", "max"].sort());
    // No effort tiers means no variants: a placeholder would surface as a
    // fake "none" reasoning variant in the picker.
    expect(Object.keys(models.auto.variants)).toEqual([]);
  });

  test("provider.models falls back to the bundled list without a session", async () => {
    const { origin } = mockVendor();
    const { plugin } = await bootPlugin(origin);
    const models = await plugin.provider.models({}, { auth: null });
    expect(Object.keys(models).length).toBeGreaterThan(8);
    expect(models["kimi-k3.1-pro"]).toBeDefined();
    // magpie decides "this is a fallback" from the returned object, and the
    // editor says so instead of advertising models the vendor never listed.
    expect(models[Symbol.for("magpie.fellBack")]).toBe(true);
    // ...and the marker must not have become a model entry.
    expect(models["Symbol(magpie.fellBack)"]).toBeUndefined();
  });

  test("a live catalog is not marked as a fallback", async () => {
    const { origin } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));
    const models = await plugin.provider.models({}, { auth: await getAuth() });
    expect(models[Symbol.for("magpie.fellBack")]).toBeUndefined();
  });

  // Both shapes are what the host reads; the top-level ones are ignored.
  test("model capabilities are declared where magpie reads them", async () => {
    const { origin } = mockVendor();
    const { plugin, getAuth, setAuth } = await bootPlugin(origin);
    setAuth(await login(plugin));
    const models = await plugin.provider.models({}, { auth: await getAuth() });

    // `capabilities.reasoning`, not top-level `reasoning` — otherwise every
    // model reports as non-reasoning and the effort variants hang off
    // nothing.
    expect(models.hy4.capabilities.reasoning).toBe(true);
    expect(models.auto.capabilities.reasoning).toBe(false);

    // `kinds()` keeps only the kinds set to true, so an all-false `input`
    // reads as "declines every input modality". `text: true` is what makes
    // it a modality list rather than a refusal.
    expect(models.hy4.capabilities.input.text).toBe(true);
    expect(models.hy4.capabilities.output.text).toBe(true);
  });

  test("config declares an openai-compatible provider", async () => {
    const { origin } = mockVendor();
    const { plugin } = await bootPlugin(origin);
    const cfg = {};
    await plugin.config(cfg);
    const p = cfg.provider.dongleya;
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.api).toBe("https://dongleya.qq.com");
    expect(Object.keys(p.models).length).toBeGreaterThan(8);
  });
});
