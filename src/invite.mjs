// Rolling invite code for 懂了鸭.
//
// 懂了鸭 is invite-only: registering gets you an account, but the first turn
// fails INVITE_REQUIRED until an invite code is redeemed. So the plugin
// redeems one for you at login, and — once an account is in — publishes that
// account's own code so the *next* login can use it. Account N sponsors
// account N+1. The first account has nobody before it, so it falls back to
// the author's code.
//
// Live contract (see test/invite.test.js):
//   GET  /api/referral/me           → { code, inviteUrl, inviteCount }
//   POST /api/access/redeem-invite  → { code, kind, rewarded }
//
// Only this plugin's own cache is touched, never magpie's private stores: a
// plugin reads a credential through the hooks, not from the host's files.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shipped fallback so the very first account on a machine gets in. */
// Human-supplied, so normalise case at the boundary: the vendor's codes are
// uppercase and its gate is case-sensitive, so a lowercase env var would
// redeem-fail and loop INVITE_INVALID.
export const AUTHOR_INVITE = String(process.env.DONGLEYA_INVITE || "RMLM4C")
  .trim()
  .toUpperCase();

/** Cache dir; DONGLEYA_CACHE_DIR exists so tests never write to the real one. */
function cacheDir() {
  return process.env.DONGLEYA_CACHE_DIR || join(homedir(), ".cache", "magpie");
}

const INVITE_FILE = () => join(cacheDir(), "dongleya-invite.json");
const POLICY_FILE = () => join(cacheDir(), "dongleya-invite-policy.json");
const CODES_FILE = () => join(cacheDir(), "dongleya-invite-codes.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write beside, then rename. A bare `writeFileSync` truncates first and
    // writes second: a crash in between leaves a partial file, and
    // `readJson` swallows the parse error and hands back the fallback — so
    // every recorded code silently reverts to nothing, with no log to say
    // why. `renameSync` is atomic, so a reader sees the old file or the new
    // one, never half of either.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Invite codes are opaque six-character tokens. Normalise hard: a paste from
 * a chat window arrives with whitespace, and an "invite URL" arrives with a
 * `?ref=` on the end. Only the token itself is useful.
 */
export function normaliseCode(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  // Accept a full invite link and dig the code out of it.
  const m = /[?&]ref=([A-Za-z0-9]+)/.exec(s);
  if (m) s = m[1];
  s = s.split(/\s+/)[0].trim();
  return /^[A-Za-z0-9]{4,32}$/.test(s) ? s : "";
}

/** The code the next login should try. Empty when nothing usable is cached. */
export function readInvite() {
  const v = readJson(INVITE_FILE(), null);
  return normaliseCode(v?.code);
}

/** Remember `code` as the one the next login redeems. Returns it, or "". */
export function writeInvite(code, { from } = {}) {
  const c = normaliseCode(code);
  if (!c) return "";
  writeJson(INVITE_FILE(), { code: c, from: from ? String(from) : "", at: new Date().toISOString() });
  return c;
}

/**
 * Forget the rolled code, so the next login falls back to the author's.
 *
 * Distinct from `writeInvite("")`, which refuses to write a blank over a good
 * code — this one means "this code is dead, drop it".
 *
 * Pass the code that failed. Compare-then-delete matters because logins run
 * concurrently (`maxConcurrency: 3`): account A can roll the pointer to a
 * fresh good code while account B's redeem of the previous one comes back
 * INVITE_INVALID. Clearing unconditionally in B would erase A's code, and if
 * the author's fallback is out of uses, every later gated login fails until
 * someone re-logs a granted account.
 */
export function clearInvite(candidate) {
  const want = normaliseCode(candidate);
  if (want) {
    const current = readInvite();
    if (current && current !== want) return;
  }
  writeJson(INVITE_FILE(), { code: "", at: new Date().toISOString() });
}

// ---- policy: roll, or pin the configured code ------------------------------

export function readPolicy() {
  const v = readJson(POLICY_FILE(), null);
  const mode = ["auto", "fixed"].includes(v?.mode) ? v.mode : "auto";
  return { mode, code: normaliseCode(v?.code) };
}

export function setPolicy({ mode, code } = {}) {
  const next = {
    mode: ["auto", "fixed"].includes(mode) ? mode : "auto",
    code: normaliseCode(code),
    at: new Date().toISOString(),
  };
  writeJson(POLICY_FILE(), next);
  return next;
}

/**
 * What a login should actually redeem.
 *
 * `fixed` is the escape hatch for an author running a referral campaign: the
 * code never moves off the configured one, even as accounts sign in. `auto`
 * (the default) hands the next account the last account's code.
 */
export function nextInvite() {
  const policy = readPolicy();
  if (policy.mode === "fixed" && policy.code) return policy.code;
  return readInvite() || AUTHOR_INVITE;
}

// ---- which account gave which code ----------------------------------------

export function noteAccountCode(accountId, code, label = "") {
  const c = normaliseCode(code);
  const id = String(accountId ?? "").trim();
  if (!c || !id) return "";
  const all = readJson(CODES_FILE(), {}) ?? {};
  all[id] = { code: c, label: String(label ?? ""), at: new Date().toISOString() };
  writeJson(CODES_FILE(), all);
  return c;
}

export function codeForAccount(accountId) {
  const id = String(accountId ?? "").trim();
  if (!id) return "";
  const all = readJson(CODES_FILE(), {}) ?? {};
  return normaliseCode(all[id]?.code);
}

/** Tests only: forget every cache file this module owns. */
export function _resetCache() {
  for (const f of [INVITE_FILE(), POLICY_FILE(), CODES_FILE()]) {
    try {
      writeJson(f, {});
    } catch {
      /* nothing to clear */
    }
  }
}
