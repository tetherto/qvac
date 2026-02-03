export const ADDON_NAMESPACES = {
  LLAMACPP_LLM: "llamacpp:llm",
  LLAMACPP_EMBED: "llamacpp:embed",
  WHISPERCPP: "whispercpp",
  TTS: "tts",
  NMTCPP: "nmtcpp",
  RAG_HYPERDB: "rag:hyperdb",
} as const;

export type AddonNamespace =
  (typeof ADDON_NAMESPACES)[keyof typeof ADDON_NAMESPACES];

// Reserved ID for SDK server logs
export const SDK_LOG_ID = "__sdk__";

// Namespace for all SDK server logs
export const SDK_SERVER_NAMESPACE = "sdk:server";
