// Re-export all schemas and types
export * from "./archive";
export * from "./cancel";
export * from "./completion-stream";
export * from "./tools";
export * from "./delegate";
export * from "./delete-cache";
export * from "./download-asset";
export * from "./embed";
export * from "./load-model";
export * from "./reload-config";
export * from "./logging-stream";
export * from "./provide";
export * from "./stop-provide";
export * from "./unload-model";
export * from "./ping";
export * from "./common";
export * from "./transcription";
export * from "./translate";
export * from "./translation-config";
export * from "./llamacpp-config";
export * from "./whispercpp-config";
export * from "./text-to-speech";
export * from "./error";
export * from "./rag";
export * from "./ocr";
export * from "./shard";
export { SDK_CLIENT_ERROR_CODES } from "./sdk-errors-client";
export { SDK_SERVER_ERROR_CODES } from "./sdk-errors-server";
export {
  qvacConfigSchema,
  deviceMatchSchema,
  deviceConfigDefaultsSchema,
  devicePatternSchema,
  type QvacConfig,
  type DeviceMatch,
  type DeviceConfigDefaults,
  type DevicePattern,
} from "./sdk-config";
export { runtimeContextSchema, type RuntimeContext } from "./runtime-context";
export * from "./get-model-info";
export * from "./model-src-utils";
export * from "./json-schema";
export { type McpClient, type McpClientInput } from "./mcp-adapter";
// Model types - new canonical naming system
export {
  ModelType,
  ModelTypeAliases,
  PUBLIC_MODEL_TYPES,
  modelTypeInputSchema,
  modelTypeSchema,
  normalizeModelType,
  isModelTypeAlias,
  // Per-model-type schemas for discriminated unions
  llmModelTypeSchema,
  whisperModelTypeSchema,
  embeddingsModelTypeSchema,
  nmtModelTypeSchema,
  ttsModelTypeSchema,
  ocrModelTypeSchema,
  type CanonicalModelType,
  type AliasKey,
  type ModelTypeInput,
  type LlmModelTypeInput,
  type WhisperModelTypeInput,
  type EmbeddingsModelTypeInput,
  type NmtModelTypeInput,
  type TtsModelTypeInput,
  type OcrModelTypeInput,
} from "./model-types";
