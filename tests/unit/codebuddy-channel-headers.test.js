import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { getExecutor } from "open-sse/executors/index.js";

// The CodeBuddy gateways (CN + intl) run a per-request channel check. Without
// the official plugin's request/conversation identifiers upstream rejects the
// call with 400 / 11128 "request illegal" ("failed channel verification").
// These tests lock the header wiring so the ids cannot silently disappear.
const REQUIRED = [
  "X-Request-ID",
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "X-Conversation-Message-ID",
];

const CREDS = { accessToken: "TESTTOKEN" };

function buildHeaders(id) {
  const executor = getExecutor(id);
  return executor.buildHeaders(CREDS, true, PROVIDERS[id].baseUrl, "deepseek-v4.1-flash", {});
}

describe("codebuddy channel headers", () => {
  for (const id of ["codebuddy-intl", "codebuddy-cn"]) {
    describe(id, () => {
      it("registers the hook only where the executor does not own the ids", () => {
        // executors/codebuddy-intl.js builds these ids itself (with casing
        // rules the generic hook cannot honour), so only cn opts in.
        const hooks = PROVIDERS[id]?.auth?.hooks ?? [];
        if (id === "codebuddy-cn") expect(hooks).toContain("codebuddyHeaders");
        else expect(hooks).not.toContain("codebuddyHeaders");
      });

      it("sends the plugin request/conversation ids", () => {
        const headers = buildHeaders(id);
        for (const key of REQUIRED) {
          expect(typeof headers[key], `${id} must send ${key}`).toBe("string");
          expect(headers[key].length).toBeGreaterThan(0);
        }
      });

      it("reuses the request id for the message and keeps the conversation id apart", () => {
        const headers = buildHeaders(id);
        // codebuddy-intl documents the mapping: X-Conversation-Message-ID
        // carries the same value as X-Request-ID, while X-Conversation-ID
        // is the per-conversation id and must not collide with it.
        expect(headers["X-Conversation-Message-ID"]).toBe(headers["X-Request-ID"]);
        expect(headers["X-Conversation-ID"]).not.toBe(headers["X-Request-ID"]);
      });

      it("still applies the bearer token after the hook runs", () => {
        expect(buildHeaders(id).Authorization).toBe("Bearer TESTTOKEN");
      });

      it("issues fresh ids per request", () => {
        const a = buildHeaders(id);
        const b = buildHeaders(id);
        expect(a["X-Request-ID"]).not.toBe(b["X-Request-ID"]);
        expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
      });
    });
  }
});
