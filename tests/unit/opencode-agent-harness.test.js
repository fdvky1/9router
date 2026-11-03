import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_AGENT_PREAMBLE } from "open-sse/assets/opencodeAgentPreamble.js";
import { OPENCODE_AGENT_TOOLS } from "open-sse/assets/opencodeAgentTools.js";
import {
  applyAgentHarness,
  loadAgentHarness,
  normalizeToolManifest,
  resetAgentHarnessCache,
} from "open-sse/utils/opencodeAgentHarness.js";

// Live probes: the free-tier gate admits a request only when it carries both the
// CLI preamble and the CLI tool manifest. Either one alone is 429.

function manifestNames(tools) {
  return tools.map((tool) => tool?.function?.name ?? tool?.name ?? "");
}

describe("agent harness snapshot", () => {
  it("bundles the CLI preamble verbatim", () => {
    expect(OPENCODE_AGENT_PREAMBLE.length).toBeGreaterThan(4000);
    expect(OPENCODE_AGENT_PREAMBLE).toContain("You are an AI agent running in OpenCode");
  });

  it("bundles the twelve-tool CLI manifest", () => {
    expect(manifestNames(OPENCODE_AGENT_TOOLS)).toEqual([
      "edit",
      "glob",
      "grep",
      "question",
      "read",
      "shell",
      "skill",
      "subagent",
      "webfetch",
      "websearch",
      "write",
      "execute",
    ]);
  });
});

describe("normalizeToolManifest", () => {
  it("accepts a bare array and a wrapped object alike", () => {
    const bare = [{ name: "read", description: "d", parameters: {} }];
    const wrapped = { tools: [{ function: { name: "read" } }] };
    expect(manifestNames(normalizeToolManifest(bare))).toEqual(["read"]);
    expect(manifestNames(normalizeToolManifest(wrapped))).toEqual(["read"]);
  });

  it("rejects a manifest that is not a tool list", () => {
    expect(() => normalizeToolManifest({ nope: true })).toThrow();
    expect(() => normalizeToolManifest("string")).toThrow();
  });
});

describe("applyAgentHarness", () => {
  const harness = {
    preamble: OPENCODE_AGENT_PREAMBLE,
    tools: normalizeToolManifest(OPENCODE_AGENT_TOOLS),
  };

  it("prepends the preamble as the system message when none exists", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyAgentHarness(body, harness);
    const messages = body.messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(OPENCODE_AGENT_PREAMBLE);
    expect(messages[1].content).toBe("hi");
  });

  it("keeps the caller's system prompt and appends the preamble ahead of it", () => {
    const body = {
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    };
    applyAgentHarness(body, harness);
    const messages = body.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain(OPENCODE_AGENT_PREAMBLE);
    expect(messages[0].content).toContain("be terse");
  });

  it("attaches the manifest while preserving caller tools", () => {
    const caller = { type: "function", function: { name: "get_weather", parameters: {} } };
    const body = { messages: [], tools: [caller] };
    applyAgentHarness(body, harness);
    const names = manifestNames(body.tools);
    expect(names).toContain("get_weather");
    expect(names).toContain("read");
    expect(names).toContain("shell");
  });

  it("never lets the manifest duplicate a caller tool name", () => {
    const caller = { type: "function", function: { name: "read", description: "mine" } };
    const body = { messages: [], tools: [caller] };
    applyAgentHarness(body, harness);
    const reads = body.tools.filter((tool) => tool.function.name === "read");
    expect(reads).toHaveLength(1);
    expect(reads[0].function.description).toBe("mine");
  });

  it("is idempotent so a retry does not stack duplicates", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyAgentHarness(body, harness);
    const first = JSON.stringify(body);
    applyAgentHarness(body, harness);
    expect(JSON.stringify(body)).toBe(first);
  });

  it("uses instructions instead of messages for the flat shape", () => {
    const body = { instructions: "be terse", input: [] };
    applyAgentHarness(body, harness, { flat: true });
    expect(body.instructions).toContain(OPENCODE_AGENT_PREAMBLE);
    expect(body.instructions).toContain("be terse");
    expect(body.messages).toBeUndefined();
  });

  it("emits flat tool shapes for the Responses lane", () => {
    const body = { instructions: "x", input: [] };
    applyAgentHarness(body, harness, { flat: true });
    const tools = body.tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.function).toBeUndefined();
      expect(tool.parameters).toBeDefined();
    }
  });

  it("ignores a body without a harness rather than throwing", () => {
    const body = { messages: [] };
    expect(applyAgentHarness(body, null)).toBe(false);
    expect(body.messages).toEqual([]);
  });
});

describe("loadAgentHarness", () => {
  beforeEach(() => {
    resetAgentHarnessCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAgentHarnessCache();
  });

  it("falls back to the bundled snapshot when upstream is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const harness = await loadAgentHarness();
    expect(harness.preamble).toBe(OPENCODE_AGENT_PREAMBLE);
    expect(manifestNames(harness.tools)).toContain("read");
  });

  it("prefers the upstream copies when they are reachable", async () => {
    const upstreamTools = [{ name: "upstream_tool", description: "d", parameters: {} }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => ({
        ok: true,
        text: async () =>
          String(url).endsWith(".json") ? JSON.stringify(upstreamTools) : "upstream preamble",
      }))
    );
    const harness = await loadAgentHarness();
    expect(harness.preamble).toBe("upstream preamble");
    expect(manifestNames(harness.tools)).toEqual(["upstream_tool"]);
  });

  it("caches the result so later requests do not refetch", async () => {
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      text: async () => (String(url).endsWith(".json") ? '[{"name":"t"}]' : "p"),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await loadAgentHarness();
    const callsAfterFirst = fetchMock.mock.calls.length;
    await loadAgentHarness();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
