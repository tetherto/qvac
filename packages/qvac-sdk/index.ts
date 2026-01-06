// Public API exports only
export {
  completion,
  deleteCache,
  loadModel,
  downloadAsset,
  ping,
  startQVACProvider,
  stopQVACProvider,
  unloadModel,
  transcribe,
  transcribeStream,
  embed,
  translate,
  cancel,
  ragSaveEmbeddings,
  ragSearch,
  ragDeleteEmbeddings,
  textToSpeech,
  getModelInfo,
  loggingStream,
} from "./client/api";
export { close } from "./client";
export {
  type ModelProgressUpdate,
  type LoadModelOptions,
  type DownloadAssetOptions,
  type Tool,
  type ToolCall,
  type ToolCallWithCall,
  type ToolCallError,
  type ToolCallEvent,
  type CompletionStats,
  VERBOSITY,
  type Attachment,
  type CompletionParams,
  type RagSearchResult,
  type RagSaveEmbeddingsResult,
  SDK_CLIENT_ERROR_CODES,
  SDK_SERVER_ERROR_CODES,
  type QvacConfig,
  type ModelInfo,
  type GetModelInfoParams,
  type LoadedInstance,
  type CacheFileInfo,
  toolSchema,
  type McpClient,
  type McpClientInput,
} from "./schemas";

export { type ToolInput, type ToolHandler } from "./utils/tool-helpers";

// Hyperdrive model constants
export * from "./models/hyperdrive";

export { SUPPORTED_AUDIO_FORMATS } from "./constants/audio";

// Logging exports
export { getLogger, SDK_LOG_ID } from "./logging";
export type { Logger, LogTransport, LoggerOptions } from "./logging";
