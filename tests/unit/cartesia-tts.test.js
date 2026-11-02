import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTtsCore, fetchCartesiaVoices, fetchCartesiaAccents } from "../../open-sse/handlers/ttsCore.js";
import { buildTtsProviderModels } from "../../open-sse/config/ttsModels.js";
import cartesiaAdapter, { CARTESIA_SUPPORTED_LANGUAGES } from "../../open-sse/handlers/ttsProviders/cartesia.js";

const originalFetch = global.fetch;

const MOCK_AUDIO_BUFFER = Buffer.from(new Uint8Array(128).fill(1));

function mockCartesiaAudioResponse(ctype = "audio/mpeg") {
  global.fetch.mockResolvedValueOnce(
    new Response(MOCK_AUDIO_BUFFER, {
      status: 200,
      headers: { "Content-Type": ctype },
    })
  );
}

describe("Cartesia TTS", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses default model sonic-3.5 and default voice when none provided", async () => {
    mockCartesiaAudioResponse();

    const result = await handleTtsCore({
      provider: "cartesia",
      model: "",
      input: "Hello from Cartesia",
      credentials: { apiKey: "cartesia-key" },
      responseFormat: "json",
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("cartesia-key");
    expect(init.headers["Cartesia-Version"]).toBe("2026-08-14");

    const sent = JSON.parse(init.body);
    expect(sent.model_id).toBe("sonic-3.5");
    expect(sent.transcript).toBe("Hello from Cartesia");
    expect(sent.voice).toEqual({ mode: "id", id: "6ccbfb76-1fc6-48f7-b71d-91ac6298247b" });
    expect(sent.output_format).toEqual({ container: "mp3", bit_rate: 128000, sample_rate: 44100 });

    const body = await result.response.json();
    expect(body.format).toBe("mp3");
    expect(body.audio).toBe(MOCK_AUDIO_BUFFER.toString("base64"));
  });

  it("parses model and voice when model/voice format is sent", async () => {
    mockCartesiaAudioResponse();

    const result = await handleTtsCore({
      provider: "cartesia",
      model: "sonic-3/custom-voice-uuid",
      input: "Speaking with sonic-3",
      credentials: { apiKey: "cartesia-key" },
    });

    expect(result.success).toBe(true);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.model_id).toBe("sonic-3");
    expect(sent.voice).toEqual({ mode: "id", id: "custom-voice-uuid" });
  });

  it("supports wav response format", async () => {
    mockCartesiaAudioResponse("audio/wav");

    const result = await handleTtsCore({
      provider: "cartesia",
      model: "sonic-3.5",
      input: "Hello in WAV format",
      credentials: { apiKey: "cartesia-key" },
      responseFormat: "wav",
    });

    expect(result.success).toBe(true);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.output_format).toEqual({ container: "wav", encoding: "pcm_s16le", sample_rate: 44100 });
    expect(result.response.headers.get("Content-Type")).toBe("audio/wav");
  });

  it("forwards optional language and style hints", async () => {
    mockCartesiaAudioResponse();

    const result = await handleTtsCore({
      provider: "cartesia",
      model: "sonic-3",
      input: "Emotional speech",
      credentials: { apiKey: "cartesia-key" },
      language: "es",
      style: "excited",
    });

    expect(result.success).toBe(true);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.language).toBe("es");
    expect(sent.generation_config).toEqual({ emotion: "excited" });
  });

  it("handles upstream synthesis errors", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Invalid voice ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await handleTtsCore({
      provider: "cartesia",
      model: "sonic-3/invalid",
      input: "Error test",
      credentials: { apiKey: "cartesia-key" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Invalid voice ID");
  });

  it("exposes Cartesia TTS models in TTS catalog", () => {
    const entries = buildTtsProviderModels();
    expect(entries["cartesia-tts-models"]).toBeDefined();
    const ids = entries["cartesia-tts-models"].map((m) => m.id);
    expect(ids).toContain("sonic-3.5");
    expect(ids).toContain("sonic-3");
    expect(ids).toContain("sonic-latest");
    expect(ids).toContain("sonic-2");
  });
});

describe("Cartesia Voices Fetcher", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches and normalizes voices from Cartesia API", async () => {
    const mockVoices = [
      {
        id: "voice-1",
        name: "Voice One",
        description: "A clear voice",
        language: "en",
        gender: "female",
        is_owner: false,
        locales: [{ locale: "en-US" }],
      },
      {
        id: "voice-2",
        name: "Voice Two",
        description: "A calm voice",
        language: "id",
        gender: "male",
        is_owner: true,
        locales: [{ locale: "id-ID" }],
      },
    ];

    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(mockVoices), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const voices = await fetchCartesiaVoices("test-cartesia-key");
    expect(voices).toHaveLength(2);
    expect(voices[0]).toEqual({
      id: "voice-1",
      name: "Voice One",
      description: "A clear voice",
      lang: "en",
      locale: "en-US",
      gender: "female",
      is_owner: false,
      locales: [{ locale: "en-US" }],
    });

    expect(global.fetch.mock.calls[0][0]).toBe("https://api.cartesia.ai/voices");
    expect(global.fetch.mock.calls[0][1].headers["X-API-Key"]).toBe("test-cartesia-key");
    expect(global.fetch.mock.calls[0][1].headers["Cartesia-Version"]).toBe("2026-08-14");
  });

  it("throws when API key is missing", async () => {
    await expect(fetchCartesiaVoices("")).rejects.toThrow("Cartesia API key required");
  });
});

describe("Cartesia Accents Fetcher", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches supported accents and languages from Cartesia API", async () => {
    const mockAccents = [
      { id: "general-american", name: "General American", language: "en", locale: "en-US", is_locale_default: true, is_localizable: true },
      { id: "jakarta", name: "Jakarta", language: "id", locale: "id-ID", is_locale_default: true, is_localizable: true },
      { id: "castilian", name: "Castilian", language: "es", locale: "es-ES", is_locale_default: true, is_localizable: true },
      { id: "parisian", name: "Parisian", language: "fr", locale: "fr-FR", is_locale_default: true, is_localizable: true },
    ];

    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ accents: mockAccents }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const accents = await fetchCartesiaAccents("test-cartesia-key");
    expect(accents).toHaveLength(4);
    expect(accents[1]).toEqual({
      id: "jakarta",
      name: "Jakarta",
      language: "id",
      locale: "id-ID",
      is_locale_default: true,
      is_localizable: true,
    });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.cartesia.ai/accents");
    expect(init.headers["X-API-Key"]).toBe("test-cartesia-key");
    expect(init.headers["Authorization"]).toBe("Bearer test-cartesia-key");
    expect(init.headers["Cartesia-Version"]).toBe("2026-08-14");
  });

  it("exposes supported languages list covering 40+ languages", () => {
    expect(CARTESIA_SUPPORTED_LANGUAGES).toContain("en");
    expect(CARTESIA_SUPPORTED_LANGUAGES).toContain("id");
    expect(CARTESIA_SUPPORTED_LANGUAGES).toContain("es");
    expect(CARTESIA_SUPPORTED_LANGUAGES).toContain("fr");
    expect(CARTESIA_SUPPORTED_LANGUAGES).toContain("ja");
    expect(CARTESIA_SUPPORTED_LANGUAGES.length).toBeGreaterThanOrEqual(40);
  });
});
