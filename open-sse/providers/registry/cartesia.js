const cartesia = {
  id: "cartesia",
  alias: "cartesia",
  display: {
    name: "Cartesia",
    icon: "spatial_audio",
    color: "#FF4F8B",
    textIcon: "CA",
    website: "https://cartesia.ai",
    notice: {
      apiKeyUrl: "https://play.cartesia.ai/keys"
    }
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: [
    "tts",
    "stt"
  ],
  models: [
    {
      id: "ink-whisper",
      name: "Ink Whisper",
      params: ["language", "response_format", "timestamps_granularity"],
      kind: "stt"
    },
    {
      id: "ink-whisper-2025-06-04",
      name: "Ink Whisper (2025-06-04)",
      params: ["language", "response_format", "timestamps_granularity"],
      kind: "stt"
    },
    {
      id: "sonic-3.5",
      name: "Sonic 3.5",
      kind: "tts"
    },
    {
      id: "sonic-3",
      name: "Sonic 3",
      kind: "tts"
    },
    {
      id: "sonic-latest",
      name: "Sonic Latest",
      kind: "tts"
    },
    {
      id: "sonic-2",
      name: "Sonic 2",
      kind: "tts"
    }
  ],
  ttsConfig: {
    baseUrl: "https://api.cartesia.ai/tts/bytes",
    authType: "apikey",
    authHeader: "x-api-key",
    format: "cartesia",
    extraHeaders: {
      "Cartesia-Version": "2026-08-14"
    },
    models: [
      {
        id: "sonic-3.5",
        name: "Sonic 3.5"
      },
      {
        id: "sonic-3",
        name: "Sonic 3"
      },
      {
        id: "sonic-latest",
        name: "Sonic Latest"
      },
      {
        id: "sonic-2",
        name: "Sonic 2"
      }
    ]
  },
  sttConfig: {
    baseUrl: "https://api.cartesia.ai/stt",
    authType: "apikey",
    authHeader: "x-api-key",
    format: "cartesia-stt",
    extraHeaders: {
      "Cartesia-Version": "2026-08-14"
    },
    responseFormats: { segments: "seg_json", subtitles: "srt", captions: "vtt" }
  }
};

export default cartesia;
