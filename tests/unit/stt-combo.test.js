import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  getComboByName: vi.fn(),
  getProviderCredentials: vi.fn(),
  handleSttCore: vi.fn(),
  getKeyAccessContext: vi.fn(),
  enforceKeyAccess: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getCustomModels: async () => [],
  getCombos: mocks.getCombos,
  getComboByName: mocks.getComboByName,
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => "test-api-key",
  isValidApiKey: async () => true,
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(),
}));

vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: mocks.getKeyAccessContext,
  enforceKeyAccess: mocks.enforceKeyAccess,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, creds) => creds,
}));

vi.mock("open-sse/handlers/sttCore.js", () => ({
  handleSttCore: mocks.handleSttCore,
}));

import { handleStt } from "@/sse/handlers/stt.js";
import { resetComboRotation } from "open-sse/services/combo.js";

function makeSttRequest(modelName, extraForm = {}) {
  const fd = new FormData();
  fd.set("model", modelName);
  const sampleAudio = new File([new Uint8Array([1, 2, 3, 4])], "test-speech.mp3", { type: "audio/mp3" });
  fd.set("file", sampleAudio);
  for (const [k, v] of Object.entries(extraForm)) {
    fd.set(k, v);
  }
  return new Request("http://localhost:20128/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer test-api-key" },
    body: fd,
  });
}

describe("STT Combo Fallback and Execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetComboRotation();

    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategy: "fallback",
    });
    mocks.getKeyAccessContext.mockResolvedValue({});
    mocks.enforceKeyAccess.mockResolvedValue(null);
    mocks.getProviderCredentials.mockImplementation(async (provider, exclude) => {
      if (exclude && exclude.has("conn-1")) return null;
      return {
        apiKey: "sk-mock-key",
        connectionName: "Primary",
        connectionId: "conn-1",
      };
    });
  });

  it("executes the primary model in a combo successfully", async () => {
    const combo = {
      id: "c1",
      name: "whisper-combo",
      kind: "stt",
      models: ["groq/whisper-large-v3", "cf/@cf/openai/whisper"],
    };
    mocks.getComboByName.mockImplementation(async (name) => (name === "whisper-combo" ? combo : null));

    mocks.handleSttCore.mockResolvedValueOnce({
      success: true,
      response: Response.json({ text: "Groq transcribed this successfully." }),
    });

    const res = await handleStt(makeSttRequest("whisper-combo"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.text).toBe("Groq transcribed this successfully.");

    // Exactly 1 model called (first model: groq)
    expect(mocks.handleSttCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleSttCore.mock.calls[0][0].provider).toBe("groq");
    expect(mocks.handleSttCore.mock.calls[0][0].model).toBe("whisper-large-v3");

    // File passed through
    const sentFd = mocks.handleSttCore.mock.calls[0][0].formData;
    expect(sentFd.get("file")).toBeInstanceOf(Blob);
    expect(sentFd.get("file").name).toBe("test-speech.mp3");
  });

  it("falls back to the secondary model when the primary model returns rate limited (429)", async () => {
    const combo = {
      id: "c1",
      name: "whisper-combo",
      kind: "stt",
      models: ["groq/whisper-large-v3", "cf/@cf/openai/whisper"],
    };
    mocks.getComboByName.mockImplementation(async (name) => (name === "whisper-combo" ? combo : null));

    // Groq fails with 429 rate limit
    mocks.handleSttCore
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "Rate limit reached for model whisper-large-v3",
      })
      // Cloudflare succeeds
      .mockResolvedValueOnce({
        success: true,
        response: Response.json({ text: "Cloudflare fallback transcribed successfully." }),
      });

    const res = await handleStt(makeSttRequest("whisper-combo"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.text).toBe("Cloudflare fallback transcribed successfully.");

    // Called both models in order
    expect(mocks.handleSttCore).toHaveBeenCalledTimes(2);
    expect(mocks.handleSttCore.mock.calls[0][0].provider).toBe("groq");
    expect(mocks.handleSttCore.mock.calls[1][0].provider).toBe("cloudflare-ai");
    expect(mocks.handleSttCore.mock.calls[1][0].model).toBe("@cf/openai/whisper");
  });

  it("rotates models when comboStrategy is round-robin", async () => {
    const combo = {
      id: "c1",
      name: "whisper-combo",
      kind: "stt",
      models: ["groq/whisper-large-v3", "cf/@cf/openai/whisper"],
    };
    mocks.getComboByName.mockImplementation(async (name) => (name === "whisper-combo" ? combo : null));
    mocks.getSettings.mockResolvedValue({
      comboStrategies: { "whisper-combo": { fallbackStrategy: "round-robin" } },
      comboStickyRoundRobinLimit: 1,
    });

    mocks.handleSttCore.mockResolvedValue({
      success: true,
      response: Response.json({ text: "ok" }),
    });

    // Request 1 -> first model (groq)
    const res1 = await handleStt(makeSttRequest("whisper-combo"));
    expect(res1.status).toBe(200);
    expect(mocks.handleSttCore.mock.calls[0][0].provider).toBe("groq");

    // Request 2 -> second model (cloudflare-ai)
    const res2 = await handleStt(makeSttRequest("whisper-combo"));
    expect(res2.status).toBe(200);
    expect(mocks.handleSttCore.mock.calls[1][0].provider).toBe("cloudflare-ai");
  });

  it("preserves optional STT parameters like language and response_format in fallback", async () => {
    const combo = {
      id: "c1",
      name: "whisper-combo",
      kind: "stt",
      models: ["groq/whisper-large-v3", "cf/@cf/openai/whisper"],
    };
    mocks.getComboByName.mockImplementation(async (name) => (name === "whisper-combo" ? combo : null));

    mocks.handleSttCore
      .mockResolvedValueOnce({
        success: false,
        status: 503,
        error: "Service temporarily unavailable",
      })
      .mockResolvedValueOnce({
        success: true,
        response: Response.json({ text: "Halo dunia" }),
      });

    const res = await handleStt(
      makeSttRequest("whisper-combo", {
        language: "id",
        prompt: "audio context",
        response_format: "json",
      })
    );
    expect(res.status).toBe(200);

    const secondCallFd = mocks.handleSttCore.mock.calls[1][0].formData;
    expect(secondCallFd.get("language")).toBe("id");
    expect(secondCallFd.get("prompt")).toBe("audio context");
    expect(secondCallFd.get("response_format")).toBe("json");
  });

  it("returns unavailable response when all combo models fail", async () => {
    const combo = {
      id: "c1",
      name: "whisper-combo",
      kind: "stt",
      models: ["groq/whisper-large-v3", "cf/@cf/openai/whisper"],
    };
    mocks.getComboByName.mockImplementation(async (name) => (name === "whisper-combo" ? combo : null));

    mocks.handleSttCore
      .mockResolvedValueOnce({
        success: false,
        status: 503,
        error: "Groq STT unavailable",
      })
      .mockResolvedValueOnce({
        success: false,
        status: 503,
        error: "Cloudflare STT unavailable",
      });

    const res = await handleStt(makeSttRequest("whisper-combo"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
