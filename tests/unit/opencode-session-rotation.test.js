// OpenCode free-tier quota is accounted PER SESSION ID, so a 429
// FreeUsageLimitError is not an account or client problem: the `x-opencode-session`
// the request carried has spent its window. Two things have to hold for a retry to
// ever succeed:
//
//   1. rotateOpencodeSession() must actually change the session the next request
//      presents — including for a client that pins its own conversation id
//      (Claude Code sends x-claude-code-session-id / metadata.user_id, which the
//      session manager turns into a stable `claude:<uuid>` seed);
//   2. the chat fallback loop must call it on that 429 instead of retrying the
//      burned session.
//
// Both were broken: rotation only dropped the canonical-session map entry, while
// Claude Code's session came from the translation cache, so every retry re-sent the
// spent session and the request ended in the same 429. A plain OpenAI-library call
// has no session hint and was unaffected — which is why the tier worked from the
// web UI and from the SDK but not from Claude Code.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import { resolveSessionId } from "open-sse/utils/sessionManager.js";
import OpenCodeExecutor, {
  OPENCODE_SESSION_RE,
  rotateOpencodeSession,
  stableSessionId,
} from "open-sse/executors/opencode.js";

const executor = new OpenCodeExecutor();
// The virtual connection src/sse/services/auth.js hands the no-auth lane: no
// connectionId field at all (it sets `id`).
const noAuthCredentials = { id: "noauth", connectionName: "Public", accessToken: "public" };

const sessionFor = ({ body = {}, credentials = noAuthCredentials, providerSessionId = "", clientTool = null } = {}) =>
  executor.prepareRequestCredentials({ body, credentials, providerSessionId, clientTool })._opencodeSession;

const CHAT = { messages: [{ role: "user", content: "hi" }] };

// What chatCore computes as `sessionSeed` (resolveSessionId over the client request).
const claudeSeed = () => resolveSessionId({
  headers: { "x-claude-code-session-id": "9a1f0c2e-aaaa-bbbb-cccc-1234567890ab" },
  body: CHAT,
  connectionId: undefined,
  scope: "opencode",
});
const librarySeed = () => resolveSessionId({ headers: {}, body: CHAT, connectionId: undefined, scope: "opencode" });

beforeEach(() => {
  // Fresh identity per test so one test's rotation cannot leak into another.
  noAuthCredentials.id = `noauth-${Math.random().toString(36).slice(2)}`;
});

describe("session shape", () => {
  it("every session the executor presents matches the CLI format", () => {
    expect(sessionFor({ providerSessionId: claudeSeed(), clientTool: "claude" })).toMatch(OPENCODE_SESSION_RE);
    expect(sessionFor({ providerSessionId: librarySeed() })).toMatch(OPENCODE_SESSION_RE);
    expect(sessionFor()).toMatch(OPENCODE_SESSION_RE);
  });
});

describe("rotation actually changes the presented session", () => {
  it("for a client that pins its own conversation id (Claude Code)", () => {
    const seed = claudeSeed();
    const before = sessionFor({ providerSessionId: seed, clientTool: "claude" });
    rotateOpencodeSession(noAuthCredentials);
    const after = sessionFor({ providerSessionId: seed, clientTool: "claude" });
    expect(after).toMatch(OPENCODE_SESSION_RE);
    expect(after).not.toBe(before);
  });

  it("for a client with no session hint at all (OpenAI library)", () => {
    const before = sessionFor();
    rotateOpencodeSession(noAuthCredentials);
    expect(sessionFor()).not.toBe(before);
  });

  it("keeps the conversation stable between rotations", () => {
    const seed = claudeSeed();
    const first = sessionFor({ providerSessionId: seed, clientTool: "claude" });
    expect(sessionFor({ providerSessionId: seed, clientTool: "claude" })).toBe(first);
    rotateOpencodeSession(noAuthCredentials);
    const rotated = sessionFor({ providerSessionId: seed, clientTool: "claude" });
    // The new session is stable too: a conversation must not mint one per turn,
    // which is what burns the quota in the first place.
    expect(sessionFor({ providerSessionId: seed, clientTool: "claude" })).toBe(rotated);
  });

  it("rotates only the identity that was exhausted", () => {
    const other = { id: "noauth-other", accessToken: "public" };
    const otherBefore = sessionFor({ credentials: other });
    rotateOpencodeSession(noAuthCredentials);
    expect(sessionFor({ credentials: other })).toBe(otherBefore);
    expect(stableSessionId(other)).toBe(otherBefore);
  });

  it("a native CLI session header is honoured and never rewritten", () => {
    const native = "ses_0123456789abABCDEFGHIJKLMN";
    const credentials = { id: "noauth-native", accessToken: "public", rawHeaders: { "x-opencode-session": native } };
    expect(sessionFor({ credentials })).toBe(native);
    // A real opencode client owns its session; rotating ours must not touch it.
    rotateOpencodeSession(credentials);
    expect(sessionFor({ credentials })).toBe(native);
  });
});

describe("chat fallback loop rotates on the free-quota 429", () => {
  const chatSource = fs.readFileSync(
    new URL("../../src/sse/handlers/chat.js", import.meta.url),
    "utf-8",
  );

  it("detects the FreeUsageLimitError body, not just the status", () => {
    expect(chatSource).toMatch(/free\\s\*usage\\s\*limit/i);
    expect(chatSource).toMatch(/FreeUsageLimitError/);
    expect(chatSource).toMatch(/Number\(result\.status\) !== 429/);
  });

  it("rotates the session before giving the error back", () => {
    expect(chatSource).toContain("rotateOpencodeSession");
    expect(chatSource).toMatch(/provider === "opencode" && isOpencodeFreeUsageLimit\(result\)/);
  });

  it("bounds the retries so the no-auth lane cannot spin forever", () => {
    // The no-auth lane re-selects the same virtual connection regardless of the
    // exclude set, so an unbounded `continue` would loop on the same spent quota.
    expect(chatSource).toMatch(/MAX_OPENCODE_ROTATIONS/);
    expect(chatSource).toMatch(/opencodeRotations < MAX_OPENCODE_ROTATIONS/);
  });

  it("does not lock the account for a spent free quota", () => {
    // The branch returns/continues before markAccountUnavailable, so a free-tier
    // quota never writes a modelLock_* on the virtual connection.
    const branch = chatSource.slice(
      chatSource.indexOf("isOpencodeFreeUsageLimit(result)"),
      chatSource.indexOf("const shouldFallback"),
    );
    expect(branch).not.toContain("markAccountUnavailable");
  });
});
