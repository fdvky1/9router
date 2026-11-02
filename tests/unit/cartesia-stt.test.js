// Cartesia STT transport contract tests.
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";

const STTCFG = {
  baseUrl: "https://api.cartesia.ai/stt",
  authType: "apikey",
  authHeader: "x-api-key",
  format: "cartesia-stt",
  version: "2026-08-14",
  responseFormats: { segments: "seg_json", subtitles: "srt", captions: "vtt" },
};
const CRED = { apiKey: "cartesia-test-key" };

const TRANSCRIPT = {
  type: "transcript",
  text: "Hello from Cartesia STT.",
  language: "en",
  duration: 2.5,
  words: [
    { word: "Hello", start: 0.1, end: 0.5 },
    { word: "from", start: 0.6, end: 0.9 },
    { word: "Cartesia", start: 1.0, end: 1.6 },
    { word: "STT.", start: 1.7, end: 2.3 },
  ],
};

function mkFile() {
  return new File([new Uint8Array([1, 2, 3, 4])], "test.wav", { type: "audio/wav" });
}

function mkFormData(extra = {}) {
  const fd = new FormData();
  fd.set("file", mkFile());
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

function stubFetch(json = TRANSCRIPT, status = 200) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, opts) => {
    calls.push({ url: String(url && url.url ? url.url : url), opts });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

function field(calls, name) {
  const form = calls[0].opts.body;
  return form.get(name);
}

async function run({ formData = mkFormData(), cfg = STTCFG, model = "ink-whisper", transport } = {}) {
  return await handleSttCore({
    provider: "cartesia",
    model,
    formData,
    credentials: CRED,
    sttConfig: cfg,
    transport,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cartesia STT dispatch", () => {
  it("hits https://api.cartesia.ai/stt with X-API-Key and Cartesia-Version headers", async () => {
    const calls = stubFetch();
    const result = await run();

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.cartesia.ai/stt");
    expect(calls[0].opts.method).toBe("POST");

    const headers = calls[0].opts.headers;
    expect(headers["x-api-key"]).toBe("cartesia-test-key");
    expect(headers["Cartesia-Version"]).toBe("2026-08-14");

    expect(field(calls, "model")).toBe("ink-whisper");
    const file = calls[0].opts.body.get("file");
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("test.wav");

    const body = await result.response.json();
    expect(body).toEqual({ text: "Hello from Cartesia STT." });
  });

  it("dispatches all Cartesia STT models registered in providerModels", async () => {
    const sttModels = (PROVIDER_MODELS.cartesia || []).filter((m) => m.kind === "stt");
    expect(sttModels.length).toBeGreaterThan(0);

    for (const m of sttModels) {
      const calls = stubFetch();
      const result = await run({ model: m.id });
      expect(result.success).toBe(true);
      expect(field(calls, "model")).toBe(m.id);
      vi.unstubAllGlobals();
    }
  });

  it("supports per-connection baseUrl override", async () => {
    const calls = stubFetch();
    const result = await handleSttCore({
      provider: "cartesia",
      model: "ink-whisper",
      formData: mkFormData(),
      credentials: { apiKey: "cartesia-test-key", providerSpecificData: { baseUrl: "https://custom.cartesia.proxy/stt" } },
      sttConfig: STTCFG,
    });
    expect(result.success).toBe(true);
    expect(calls[0].url).toBe("https://custom.cartesia.proxy/stt");
  });

  it("short-circuits on missing credentials with 401", async () => {
    const calls = stubFetch();
    const result = await handleSttCore({
      provider: "cartesia",
      model: "ink-whisper",
      formData: mkFormData(),
      sttConfig: STTCFG,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("propagates upstream errors gracefully", async () => {
    stubFetch({ message: "Invalid model specified", type: "error" }, 400);
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Invalid model specified");
  });
});

describe("Cartesia STT request parameters", () => {
  it("forwards language when provided, omits when blank", async () => {
    const callsBlank = stubFetch();
    await run({ formData: mkFormData({ language: "   " }) });
    expect(callsBlank[0].opts.body.get("language")).toBeNull();
    vi.unstubAllGlobals();

    const callsLang = stubFetch();
    await run({ formData: mkFormData({ language: "id" }) });
    expect(field(callsLang, "language")).toBe("id");
  });

  it("requests word timestamps when timestamps_granularity or verbose_json is set", async () => {
    const callsGran = stubFetch();
    await run({ formData: mkFormData({ timestamps_granularity: "word" }) });
    expect(field(callsGran, "timestamp_granularities[]")).toBe("word");
    vi.unstubAllGlobals();

    const callsVerbose = stubFetch();
    await run({ formData: mkFormData({ response_format: "verbose_json" }) });
    expect(field(callsVerbose, "timestamp_granularities[]")).toBe("word");
  });
});

describe("Cartesia STT response formats", () => {
  it("response_format=json returns { text }", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "json" }) });
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body).toEqual({ text: "Hello from Cartesia STT." });
  });

  it("response_format=text returns plain text", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "text" }) });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toContain("text/plain");
    const text = await result.response.text();
    expect(text).toBe("Hello from Cartesia STT.");
  });

  it("response_format=verbose_json returns text, duration, words, and segments", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "verbose_json" }) });
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.text).toBe("Hello from Cartesia STT.");
    expect(body.duration).toBe(2.5);
    expect(body.language).toBe("en");
    expect(body.words).toHaveLength(4);
    expect(body.segments).toBeDefined();
    expect(body.segments.length).toBeGreaterThan(0);
    expect(body.segments[0]).toHaveProperty("start");
    expect(body.segments[0]).toHaveProperty("end");
    expect(body.segments[0]).toHaveProperty("text");
  });

  it("response_format=srt formats SRT subtitles from word timestamps", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "srt" }) });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toContain("text/plain");
    const srt = await result.response.text();
    expect(srt).toContain("-->");
    expect(srt).toContain("Hello from Cartesia STT.");
  });

  it("response_format=vtt formats WebVTT subtitles from word timestamps", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "vtt" }) });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toContain("text/plain");
    const vtt = await result.response.text();
    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("-->");
    expect(vtt).toContain("Hello from Cartesia STT.");
  });
});
