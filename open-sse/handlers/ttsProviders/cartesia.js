// Cartesia TTS adapter — supports voice id with optional model_id prefix
import { parseModelVoice, responseToBase64, throwUpstreamError } from "./_base.js";

const VOICES_TTL = 24 * 60 * 60 * 1000;
const _voicesCache = new Map(); // by API key
const _accentsCache = new Map(); // by API key

export const CARTESIA_SUPPORTED_LANGUAGES = [
  "en", "fr", "de", "es", "pt", "zh", "ja", "hi", "it", "ko",
  "nl", "pl", "ru", "sv", "tr", "tl", "bg", "ro", "ar", "cs",
  "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "hu", "no",
  "vi", "bn", "th", "he", "ka", "id", "te", "gu", "kn", "ml",
  "mr", "pa", "or", "ur",
];

export async function fetchCartesiaAccents(apiKey, baseUrl = "https://api.cartesia.ai/accents") {
  if (!apiKey) throw new Error("Cartesia API key required");
  const now = Date.now();
  const cached = _accentsCache.get(apiKey);
  if (cached && now - cached.time < VOICES_TTL) return cached.accents;

  const res = await fetch(baseUrl, {
    headers: {
      "X-API-Key": apiKey,
      "Authorization": `Bearer ${apiKey}`,
      "Cartesia-Version": "2026-08-14",
    },
  });
  if (!res.ok) throw new Error(`Cartesia accents fetch failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data) ? data : (data?.accents || []);
  _accentsCache.set(apiKey, { accents: raw, time: now });
  return raw;
}

export async function fetchCartesiaVoices(apiKey, baseUrl = "https://api.cartesia.ai/voices") {
  if (!apiKey) throw new Error("Cartesia API key required");
  const now = Date.now();
  const cached = _voicesCache.get(apiKey);
  if (cached && now - cached.time < VOICES_TTL) return cached.voices;

  const res = await fetch(baseUrl, {
    headers: {
      "X-API-Key": apiKey,
      "Cartesia-Version": "2026-08-14",
    },
  });
  if (!res.ok) throw new Error(`Cartesia voices fetch failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data) ? data : (data?.data || []);

  const voices = raw.map((v) => {
    const primaryLocale = v.locales?.[0]?.locale || "";
    const primaryLang = v.language || (primaryLocale ? primaryLocale.split("-")[0] : "en");
    return {
      id: v.id,
      name: v.name || v.id,
      description: v.description || "",
      lang: primaryLang,
      locale: primaryLocale || primaryLang,
      gender: v.gender || "",
      is_owner: v.is_owner === true,
      locales: v.locales || [],
    };
  });

  _voicesCache.set(apiKey, { voices, time: now });
  return voices;
}

const KNOWN_MODELS = [
  "sonic-3.5",
  "sonic-3",
  "sonic-latest",
  "sonic-2",
  "sonic-3.5-2026-05-04",
  "sonic-3-2026-01-12",
  "sonic-3-2025-10-27",
];

const DEFAULT_MODEL = "sonic-3.5";
const DEFAULT_VOICE = "6ccbfb76-1fc6-48f7-b71d-91ac6298247b";

const cartesiaAdapter = {
  async synthesize(text, model, credentials, responseFormat = "mp3", options = {}) {
    if (!credentials?.apiKey) throw new Error("Cartesia API key required");

    const { modelId, voiceId } = parseModelVoice(model, DEFAULT_MODEL, DEFAULT_VOICE, KNOWN_MODELS);
    const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.cartesia.ai/tts/bytes";

    const isWav = responseFormat === "wav";
    const outputFormat = isWav
      ? { container: "wav", encoding: "pcm_s16le", sample_rate: 44100 }
      : { container: "mp3", bit_rate: 128000, sample_rate: 44100 };

    const body = {
      model_id: modelId,
      transcript: text,
      voice: { mode: "id", id: voiceId },
      output_format: outputFormat,
      ...(options?.language ? { language: options.language } : {}),
      ...(options?.style ? { generation_config: { emotion: options.style } } : {}),
    };

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": credentials.apiKey,
        "Cartesia-Version": "2026-08-14",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) await throwUpstreamError(res);
    return responseToBase64(res, isWav ? "wav" : "mp3");
  },
};

export default cartesiaAdapter;
