// Single source: build PROVIDERS + PROVIDER_MODELS from registry/{id}.js (transport + models co-located).
import REGISTRY from "./registry/index.js";
import { PROVIDER_DEFAULTS } from "./schema.js";
import { normalizeModel } from "./models/schema.js";
import { buildTtsProviderModels } from "../config/ttsModels.js";

// oauth block is canonical for these fields; inject into transport so executors reading
// this.config.{clientId,clientSecret,tokenUrl} keep working without duplicating in transport
const OAUTH_INJECT_FIELDS = ["clientId", "clientSecret", "tokenUrl"];

// transport: re-apply shared default (format:"openai") + inject oauth-canonical fields
function buildTransport(transport, oauth) {
  const t = { ...transport };
  if (!t.format) t.format = PROVIDER_DEFAULTS.format;
  if (oauth) {
    for (const f of OAUTH_INJECT_FIELDS) {
      if (t[f] === undefined && oauth[f] !== undefined) t[f] = oauth[f];
    }
  }
  return t;
}

const MEDIA_KEYS = new Set([
  "serviceKinds", "ttsConfig", "sttConfig", "embeddingConfig",
  "imageConfig", "imageToTextConfig", "videoConfig", "musicConfig",
  "searchViaChat", "searchConfig", "fetchConfig", "systemoneConfig",
  "modelsFetcher", "mediaPriority", "hiddenKinds",
]);

// Media catalogs are declared inside their per-kind config block
// (`ttsConfig.models`, `embeddingConfig.models`, …) instead of the top-level
// `models[]`. Fold them into PROVIDER_MODELS so every consumer — dashboard
// pickers, /v1/models, per-key access lists — reads one catalog per provider.
// Without this, a provider that declares its models only there (aws-polly,
// jina, inworld, playht, fish-audio, coqui, tortoise) has no catalog at all and
// cannot be selected anywhere, not even for "restrict access".
const MEDIA_MODEL_FIELDS = [
  ["ttsConfig", "tts"],
  ["sttConfig", "stt"],
  ["embeddingConfig", "embedding"],
  ["imageConfig", "image"],
  ["imageToTextConfig", "imageToText"],
  ["videoConfig", "video"],
  ["musicConfig", "music"],
  ["systemoneConfig", "systemone"],
];

// Config-block models carry no `kind`; tag them with the block's kind so the
// catalog is filterable. An explicit `kind`/`type` on the entry always wins.
function mediaCatalogModels(entry) {
  const out = [];
  for (const [field, kind] of MEDIA_MODEL_FIELDS) {
    for (const raw of entry[field]?.models || []) {
      const model = typeof raw === "string" ? { id: raw } : raw;
      if (!model?.id) continue;
      out.push({ kind, ...model });
    }
  }
  return out;
}

export const PROVIDERS = {};
export const PROVIDER_MODELS = {};
export const PROVIDER_OAUTH = {};
export const PROVIDER_MEDIA = {};
for (const entry of REGISTRY) {
  if (entry.transport) {
    PROVIDERS[entry.id] = buildTransport(entry.transport, entry.oauth);
    if (entry.transports) PROVIDERS[entry.id].transports = entry.transports;
  }
  if (entry.models !== undefined) PROVIDER_MODELS[entry.alias || entry.id] = entry.models.map(normalizeModel);
  // Providers that declare models only inside a per-kind config block still need a
  // catalog entry, so merge those in (deduped by id; the top-level entry wins).
  const mediaModels = mediaCatalogModels(entry);
  if (mediaModels.length) {
    const key = entry.alias || entry.id;
    const existing = PROVIDER_MODELS[key] || [];
    const seen = new Set(existing.map((m) => m.id));
    PROVIDER_MODELS[key] = [
      ...existing,
      ...mediaModels.filter((m) => !seen.has(m.id)).map(normalizeModel),
    ];
  }
  if (entry.oauth) PROVIDER_OAUTH[entry.id] = entry.oauth;
  // Build PROVIDER_MEDIA from top-level fields (post-migration) + legacy entry.media
  const mediaFields = {};
  for (const k of MEDIA_KEYS) {
    if (entry[k] !== undefined) mediaFields[k] = entry[k];
  }
  if (entry.media) Object.assign(mediaFields, entry.media);
  if (Object.keys(mediaFields).length) PROVIDER_MEDIA[entry.id] = mediaFields;
}

// TTS model/voice tables keyed by special names (openai-tts-models, ...), not provider ids
Object.assign(PROVIDER_MODELS, buildTtsProviderModels());
