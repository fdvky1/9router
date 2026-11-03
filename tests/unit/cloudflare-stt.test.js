// Cloudflare Workers AI STT transport contract tests.
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { getProvidersByKind } from "@/shared/constants/providers.js";

const STTCFG = {
  baseUrl: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/{model}",
  authType: "apikey",
  authHeader: "bearer",
  format: "cloudflare-stt",
};

const CRED = {
  apiKey: "cf-test-token",
  providerSpecificData: {
    accountId: "test-account-12345",
  },
};

const TRANSCRIPT_RESULT = {
  text: "Hello from Cloudflare Whisper STT.",
  vtt: "WEBVTT\n\n00:00:00.100 --> 00:00:02.300\nHello from Cloudflare Whisper STT.\n",
  word_count: 5,
  words: [
    { word: "Hello", start: 0.1, end: 0.5 },
    { word: "from", start: 0.6, end: 0.9 },
    { word: "Cloudflare", start: 1.0, end: 1.5 },
    { word: "Whisper", start: 1.6, end: 2.0 },
    { word: "STT.", start: 2.1, end: 2.3 },
  ],
};

const TURBO_TRANSCRIPT_RESULT = {
  text: "Hello from Whisper Large v3 Turbo.",
  transcription_info: {
    language: "en",
    language_probability: 0.99,
    duration: 3.2,
  },
  word_count: 6,
  words: [
    { word: "Hello", start: 0.1, end: 0.5 },
    { word: "from", start: 0.6, end: 0.9 },
    { word: "Whisper", start: 1.0, end: 1.5 },
    { word: "Large", start: 1.6, end: 2.0 },
    { word: "v3", start: 2.1, end: 2.5 },
    { word: "Turbo.", start: 2.6, end: 3.1 },
  ],
  segments: [
    {
      id: 0,
      start: 0.1,
      end: 3.1,
      text: "Hello from Whisper Large v3 Turbo.",
    },
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

function stubFetch(result = TRANSCRIPT_RESULT, status = 200, success = true, errors = []) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, opts) => {
    calls.push({ url: String(url && url.url ? url.url : url), opts });
    const payload = success
      ? { result, success: true, errors: [], messages: [] }
      : { success: false, errors: errors.length ? errors : [{ code: 7504, message: "Validation failed" }], messages: [] };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

async function run({
  formData = mkFormData(),
  cfg = STTCFG,
  model = "@cf/openai/whisper",
  credentials = CRED,
  transport,
} = {}) {
  return await handleSttCore({
    provider: "cloudflare-ai",
    model,
    formData,
    credentials,
    sttConfig: cfg,
    transport,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare Workers AI STT registration", () => {
  it("appears in getProvidersByKind('stt')", () => {
    const providers = getProvidersByKind("stt");
    const cf = providers.find((p) => p.id === "cloudflare-ai");
    expect(cf).toBeDefined();
    expect(cf.alias).toBe("cf");
    expect(cf.serviceKinds).toContain("stt");
    expect(cf.sttConfig).toBeDefined();
    expect(cf.sttConfig.format).toBe("cloudflare-stt");
  });

  it("registers whisper, whisper-large-v3-turbo, and whisper-tiny-en as STT models", () => {
    const models = PROVIDER_MODELS["cf"] || PROVIDER_MODELS["cloudflare-ai"];
    expect(models).toBeDefined();
    const sttModels = models.filter((m) => m.kind === "stt");
    expect(sttModels.length).toBe(3);

    const ids = sttModels.map((m) => m.id);
    expect(ids).toContain("@cf/openai/whisper");
    expect(ids).toContain("@cf/openai/whisper-large-v3-turbo");
    expect(ids).toContain("@cf/openai/whisper-tiny-en");
  });
});

describe("Cloudflare Workers AI STT dispatch", () => {
  it("hits the correct Cloudflare REST API endpoint with Bearer auth and accountId", async () => {
    const calls = stubFetch();
    const result = await run();

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account-12345/ai/run/@cf/openai/whisper"
    );
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.headers.Authorization).toBe("Bearer cf-test-token");
    expect(calls[0].opts.headers["Content-Type"]).toBe("audio/wav");

    const body = await result.response.json();
    expect(body).toEqual({ text: "Hello from Cloudflare Whisper STT." });
  });

  it("sends raw binary audio for @cf/openai/whisper", async () => {
    const calls = stubFetch();
    const result = await run({ model: "@cf/openai/whisper" });

    expect(result.success).toBe(true);
    expect(calls[0].opts.body).toBeInstanceOf(ArrayBuffer);
  });

  it("sends raw binary audio for @cf/openai/whisper-tiny-en", async () => {
    const calls = stubFetch();
    const result = await run({ model: "@cf/openai/whisper-tiny-en" });

    expect(result.success).toBe(true);
    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account-12345/ai/run/@cf/openai/whisper-tiny-en"
    );
    expect(calls[0].opts.body).toBeInstanceOf(ArrayBuffer);
  });

  it("sends JSON with base64 audio, language, and initial_prompt for whisper-large-v3-turbo", async () => {
    const calls = stubFetch(TURBO_TRANSCRIPT_RESULT);
    const fd = mkFormData({ language: "en", prompt: "Meeting notes" });
    const result = await run({ model: "@cf/openai/whisper-large-v3-turbo", formData: fd });

    expect(result.success).toBe(true);
    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account-12345/ai/run/@cf/openai/whisper-large-v3-turbo"
    );
    expect(calls[0].opts.headers["Content-Type"]).toBe("application/json");

    const sentJson = JSON.parse(calls[0].opts.body);
    expect(sentJson.audio).toBe(Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"));
    expect(sentJson.language).toBe("en");
    expect(sentJson.initial_prompt).toBe("Meeting notes");

    const body = await result.response.json();
    expect(body).toEqual({ text: "Hello from Whisper Large v3 Turbo." });
  });

  it("normalizes short model names to @cf/openai/ prefix", async () => {
    const calls = stubFetch();
    const result = await run({ model: "whisper" });

    expect(result.success).toBe(true);
    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account-12345/ai/run/@cf/openai/whisper"
    );
  });

  it("requires accountId in providerSpecificData", async () => {
    const calls = stubFetch();
    const result = await run({
      credentials: { apiKey: "cf-test-token" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("accountId");
    expect(calls).toHaveLength(0);
  });

  it("short-circuits on missing credentials with 401", async () => {
    const calls = stubFetch();
    const result = await run({ credentials: null });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("supports per-connection baseUrl override", async () => {
    const calls = stubFetch();
    const result = await run({
      credentials: {
        apiKey: "cf-test-token",
        providerSpecificData: {
          accountId: "test-account-12345",
          baseUrl: "https://my-cloudflare-proxy.example.com/ai/run/{model}",
        },
      },
    });

    expect(result.success).toBe(true);
    expect(calls[0].url).toBe(
      "https://my-cloudflare-proxy.example.com/ai/run/@cf/openai/whisper"
    );
  });

  it("propagates upstream errors gracefully from HTTP error status", async () => {
    stubFetch({}, 401, false, [{ code: 10000, message: "Authentication error" }]);
    const result = await run();

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("Authentication error");
  });

  it("handles Cloudflare success=false payloads with status 200", async () => {
    stubFetch({}, 200, false, [{ code: 7505, message: "Rate limit exceeded" }]);
    const result = await run();

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Rate limit exceeded");
  });
});

describe("Cloudflare Workers AI STT response formats", () => {
  it("response_format=json returns { text }", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "json" }) });
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body).toEqual({ text: "Hello from Cloudflare Whisper STT." });
  });

  it("response_format=text returns plain text", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "text" }) });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toContain("text/plain");
    const text = await result.response.text();
    expect(text).toBe("Hello from Cloudflare Whisper STT.");
  });

  it("response_format=vtt returns WebVTT subtitles", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "vtt" }) });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toContain("text/plain");
    const vtt = await result.response.text();
    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("-->");
    expect(vtt).toContain("Hello from Cloudflare Whisper STT.");
  });

  it("response_format=srt formats SRT subtitles from word timestamps", async () => {
    stubFetch();
    const result = await run({ formData: mkFormData({ response_format: "srt" }) });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toContain("text/plain");
    const srt = await result.response.text();
    expect(srt).toContain("-->");
    expect(srt).toContain("Hello from Cloudflare Whisper STT.");
  });

  it("response_format=verbose_json returns text, duration, language, words, and segments", async () => {
    stubFetch(TURBO_TRANSCRIPT_RESULT);
    const result = await run({
      model: "@cf/openai/whisper-large-v3-turbo",
      formData: mkFormData({ response_format: "verbose_json" }),
    });

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.text).toBe("Hello from Whisper Large v3 Turbo.");
    expect(body.language).toBe("en");
    expect(body.duration).toBe(3.2);
    expect(body.words).toHaveLength(6);
    expect(body.segments).toBeDefined();
    expect(body.segments).toHaveLength(1);
    expect(body.segments[0].text).toBe("Hello from Whisper Large v3 Turbo.");
  });
});
