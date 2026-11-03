// Per-API-key access control for MEDIA models.
//
// A key's allow list is not chat-only: /v1/audio/speech, /v1/images/generations,
// /v1/embeddings, /v1/audio/transcriptions and /v1/videos/generations all run the
// same gate. Three things used to keep media models out of it entirely:
//
//   1. providers that declare their catalog inside a per-kind config block
//      (`ttsConfig.models`, `embeddingConfig.models`, …) had NO catalog entry, so
//      the picker could not offer them and the gate could not match them;
//   2. keyless media providers live in the "freeTier" category, which the picker
//      and /v1/models only scanned under "free" — so they never appeared;
//   3. a TTS target carries its voice in the model string
//      ("openai/tts-1/alloy"), which no allow-list entry spells out.
//
// Each block below pins one of those.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({ combos: [], keys: {}, aliases: {}, nodes: [] }));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => fx.aliases,
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => fx.nodes,
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] || null }));
vi.mock("@/sse/utils/logger.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));

const engine = await import("../../src/sse/services/keyAccess.js");
const { PROVIDER_MODELS } = await import("open-sse/config/providerModels.js");
const REGISTRY = (await import("open-sse/providers/registry/index.js")).default;
const { readFileSync } = await import("node:fs");

const readSource = (relative) => readFileSync(new URL(relative, import.meta.url), "utf-8");
const PICKER_SRC = readSource("../../src/shared/components/ModelSelectModal.js");
const KEY_ACCESS_SRC = readSource("../../src/app/(dashboard)/dashboard/endpoint/components/KeyAccessControls.js");

function key(id, allow) {
  fx.keys[`sk-${id}`] = { id, name: `key-${id}`, isActive: true, access: { restricted: true, allow } };
}
const req = (k) => new Request("http://localhost/v1/audio/speech", {
  method: "POST",
  headers: { Authorization: `Bearer ${k}` },
});
const ctxFor = (k) => engine.getKeyAccessContext(req(k));
async function allowed(k, model) {
  return (await engine.enforceKeyAccess(await ctxFor(k), model)) === null;
}

beforeEach(() => {
  fx.keys = {};
  fx.combos = [];
  fx.aliases = {};
  fx.nodes = [];
});

describe("media catalogs declared inside a per-kind config block are published", () => {
  // Providers whose ONLY catalog is `ttsConfig.models` / `embeddingConfig.models`.
  const CONFIG_ONLY = [
    ["aws-polly", "polly", "ttsConfig", "tts"],
    ["jina-ai", "jina", "embeddingConfig", "embedding"],
    ["inworld", "inworld", "ttsConfig", "tts"],
    ["playht", "playht", "ttsConfig", "tts"],
    ["fish-audio", "fish", "ttsConfig", "tts"],
    ["coqui", "coqui", "ttsConfig", "tts"],
    ["tortoise", "tortoise", "ttsConfig", "tts"],
  ];

  it.each(CONFIG_ONLY)("%s declares %s models and they reach PROVIDER_MODELS", (providerId, alias, field, kind) => {
    const entry = REGISTRY.find((r) => r.id === providerId);
    expect(entry?.[field]?.models?.length).toBeGreaterThan(0);
    const published = PROVIDER_MODELS[alias] || [];
    for (const raw of entry[field].models) {
      const id = typeof raw === "string" ? raw : raw.id;
      const found = published.find((m) => m.id === id);
      expect(found, `${alias}/${id} missing from PROVIDER_MODELS`).toBeTruthy();
      expect(found.kind).toBe(kind);
    }
  });

  it("keeps the kind declared by the entry itself (elevenlabs TTS + STT in one catalog)", () => {
    const elevenlabs = PROVIDER_MODELS.el || [];
    expect(elevenlabs.find((m) => m.id === "eleven_multilingual_v2")?.kind).toBe("tts");
    expect(elevenlabs.find((m) => m.id === "scribe_v1")?.kind).toBe("stt");
  });

  it("does not duplicate a model declared both top-level and in a config block", () => {
    const ids = (PROVIDER_MODELS.el || []).map((m) => m.id);
    expect(ids.filter((id) => id === "eleven_turbo_v2_5")).toHaveLength(1);
  });
});

describe("a restricted key can call the media model it lists", () => {
  it("allows every published media model kind and denies its siblings", async () => {
    key("media", [
      "polly/neural",
      "jina/jina-embeddings-v3",
      "inworld/inworld-tts-1.5-mini",
      "fish/s2.1-pro",
      "openai/tts-1",
      "openai/dall-e-3",
      "openai/whisper-1",
      "openai/text-embedding-3-small",
    ]);
    const allowedTargets = [
      "polly/neural",
      "jina/jina-embeddings-v3",
      "inworld/inworld-tts-1.5-mini",
      "fish/s2.1-pro",
      "openai/tts-1",
      "openai/dall-e-3",
      "openai/whisper-1",
      "openai/text-embedding-3-small",
    ];
    for (const m of allowedTargets) expect(await allowed("sk-media", m), m).toBe(true);
    for (const m of ["polly/standard", "jina/jina-embeddings-v2-base-en", "openai/tts-1-hd", "openai/dall-e-2"]) {
      expect(await allowed("sk-media", m), m).toBe(false);
    }
  });

  it("matches a TTS target that carries its voice, when the model is listed", async () => {
    key("voice", ["openai/tts-1"]);
    // "openai/tts-1/alloy" is the wire form the dashboard example card sends.
    expect(await allowed("sk-voice", "openai/tts-1/alloy")).toBe(true);
    expect(await allowed("sk-voice", "openai/tts-1/nova")).toBe(true);
    // A voice suffix must not smuggle in a model that is not listed.
    expect(await allowed("sk-voice", "openai/tts-1-hd/alloy")).toBe(false);
  });

  it("matches a provider alias and its full id as one target", async () => {
    key("alias", ["polly/neural"]);
    expect(await allowed("sk-alias", "aws-polly/neural")).toBe(true);
    key("canon", ["aws-polly/neural"]);
    expect(await allowed("sk-canon", "polly/neural")).toBe(true);
  });

  it("is case-insensitive like every other target", async () => {
    key("case", ["polly/NEURAL"]);
    expect(await allowed("sk-case", "polly/neural")).toBe(true);
  });
});

describe("a bare provider entry is a search/fetch target, not a phantom model", () => {
  it("allows the listed provider for search/fetch and does not invent a model", async () => {
    key("search", ["tavily"]);
    const ctx = await ctxFor("sk-search");
    expect(await engine.enforceKeyAccessProvider(ctx, "tavily", null)).toBeNull();
    // A model string on that provider is a different target and stays denied.
    expect(await allowed("sk-search", "tavily/tavily-search")).toBe(false);
  });
});

describe("/v1/models filtering keeps media entries", () => {
  it("lists the media model a restricted key names and drops the rest", async () => {
    key("list", ["polly/neural", "jina/jina-embeddings-v3"]);
    const list = [
      { id: "polly/neural", object: "model", owned_by: "polly" },
      { id: "polly/standard", object: "model", owned_by: "polly" },
      { id: "jina/jina-embeddings-v3", object: "model", owned_by: "jina" },
      { id: "openai/tts-1", object: "model", owned_by: "openai" },
    ];
    const out = await engine.filterModelsListForKey(await ctxFor("sk-list"), list);
    expect(out.map((m) => m.id)).toEqual(["polly/neural", "jina/jina-embeddings-v3"]);
  });
});

describe("the picker offers every kind for an allow list", () => {
  it("KeyAccessControls opens the picker with allKinds", () => {
    expect(KEY_ACCESS_SRC).toMatch(/allKinds/);
  });

  it("ModelSelectModal accepts allKinds and bypasses the kind filter with it", () => {
    expect(PICKER_SRC).toMatch(/allKinds = false/);
    expect(PICKER_SRC).toMatch(/if \(allKinds\) return models;/);
    expect(PICKER_SRC).toMatch(/!kindFilter \|\| allKinds/);
  });

  it("keyless media providers are offered without a connection", () => {
    // edge-tts / google-tts / local-device / coqui / tortoise have no connection,
    // so the no-auth id list must be derived from BOTH keyless categories.
    const noAuthBlock = PICKER_SRC.slice(
      PICKER_SRC.indexOf("const NO_AUTH_PROVIDER_IDS"),
      PICKER_SRC.indexOf("const NO_AUTH_PROVIDER_IDS") + 400,
    );
    expect(noAuthBlock).toContain("FREE_PROVIDERS");
    expect(noAuthBlock).toContain("FREE_TIER_PROVIDERS");
    expect(noAuthBlock).toContain("noAuth");
  });
});
