// test/invite.test.js — the rolling invite chain.
//
// Contract (verified live against dongleya.qq.com):
//   GET  /api/referral/me              → { code, inviteUrl, inviteCount }
//   POST /api/access/redeem-invite     → { code, kind:"referral", rewarded }
//     · invalid code  → HTTP 200, code:10010, codeName:"INVITE_INVALID"
//     · already used  → HTTP 200, success:true, rewarded:false   (idempotent)
//
// The chain: an account that has been let in publishes its own code, and that
// code becomes what the *next* login redeems. The first account has nobody
// before it, so it falls back to the author's code.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// invite.mjs resolves its cache dir once per call, so point it at a scratch
// dir before anything touches the real ~/.cache/magpie.
const scratch = mkdtempSync(join(tmpdir(), "dongleya-invite-"));
process.env.DONGLEYA_CACHE_DIR = scratch;
process.env.DONGLEYA_INVITE = "";

const invite = await import("../src/invite.mjs");

beforeEach(() => invite._resetCache());
afterEach(() => invite._resetCache());

describe("rolling invite", () => {
  test("no cached code falls back to the author's", () => {
    expect(invite.readInvite()).toBe("");
    expect(invite.nextInvite()).toBe(invite.AUTHOR_INVITE);
  });

  test("a rolled code takes over from the author's", () => {
    invite.writeInvite("QGFR9R", { from: "4616" });
    expect(invite.readInvite()).toBe("QGFR9R");
    expect(invite.nextInvite()).toBe("QGFR9R");
  });

  test("the author code is the shipped default and is overridable by env", () => {
    // Pinned so a refactor cannot silently rotate the code users start from.
    expect(invite.AUTHOR_INVITE).toBe(
      String(process.env.DONGLEYA_INVITE || "RMLM4C").trim(),
    );
  });

  test("blank writes never clobber a good code", () => {
    invite.writeInvite("QGFR9R");
    expect(invite.writeInvite("")).toBe("");
    expect(invite.writeInvite("   ")).toBe("");
    expect(invite.readInvite()).toBe("QGFR9R");
  });

  test("codes are normalised: trimmed, and only the first token kept", () => {
    invite.writeInvite("  qgfr9r  ");
    expect(invite.readInvite()).toBe("qgfr9r");
  });

  test("a pinned policy keeps the configured code instead of rolling", () => {
    invite.setPolicy({ mode: "fixed", code: "PINNED" });
    invite.writeInvite("QGFR9R");
    expect(invite.nextInvite()).toBe("PINNED");
  });

  test("auto policy (the default) follows the roll", () => {
    invite.setPolicy({ mode: "auto" });
    invite.writeInvite("QGFR9R");
    expect(invite.nextInvite()).toBe("QGFR9R");
  });

  test("per-account code memory survives a roll", () => {
    invite.noteAccountCode("4616", "QGFR9R");
    invite.writeInvite("OTHER1");
    expect(invite.codeForAccount("4616")).toBe("QGFR9R");
    expect(invite.readInvite()).toBe("OTHER1");
  });

  test("a corrupt cache file degrades to the fallback, never throws", () => {
    const fs = require("node:fs");
    fs.writeFileSync(join(scratch, "dongleya-invite.json"), "{not json");
    expect(() => invite.readInvite()).not.toThrow();
    expect(invite.nextInvite()).toBe(invite.AUTHOR_INVITE);
  });
});
