// Custom node providers (openai-compatible-* / custom-embedding-*) — baseUrl from credentials
import createOpenAIEmbeddingAdapter from "./openai.js";

const baseAdapter = createOpenAIEmbeddingAdapter("openai");

export default {
  ...baseAdapter,
  buildUrl: (_model, creds) => {
    const rawBaseUrl = creds?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
    const baseUrl = rawBaseUrl.replace(/\/$/, "").replace(/\/embeddings$/, "");
    return `${baseUrl}/embeddings`;
  },
  buildHeaders: (creds, ctx) => {
    const headers = baseAdapter.buildHeaders(creds, ctx);
    const nodeHeaders = creds?.providerSpecificData?.headers;
    if (nodeHeaders && typeof nodeHeaders === "object") {
      Object.assign(headers, nodeHeaders);
    }
    return headers;
  },
};
