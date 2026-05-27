import "#polyfill-bare-globals";

// Public API exports only
export {
  completion,
  deleteCache,
  loadModel,
  downloadAsset,
  heartbeat,
  startQVACProvider,
  stopQVACProvider,
  unloadModel,
  transcribe,
  transcribeStream,
  embed,
  finetune,
  translate,
  cancel,
  ragChunk,
  ragIngest,
  ragSaveEmbeddings,
  ragSearch,
  ragDeleteEmbeddings,
  ragReindex,
  ragListWorkspaces,
  ragCloseWorkspace,
  ragDeleteWorkspace,
  textToSpeech,
  textToSpeechStream,
  getModelInfo,
  getLoadedModelInfo,
  loggingStream,
  ocr,
  invokePlugin,
  invokePluginStream,
  diffusion,
  type DiffusionProgressTick,
  classify,
  video,
  type VideoProgressTick,
  upscale,
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
  type ModelRegistrySearchParams,
  suspend,
  resume,
  state,
  vla,
  vlaHparams,
  vlaPreprocessImage,
  vlaPadState,
  VLA_DEFAULT_IMAGE_SIZE,
  type FinetuneHandle,
} from "./client/api";
export { close } from "./client";
export {
  type LifecycleState,
  type ModelProgressUpdate,
  type LoadModelOptions,
  type LoadCustomPluginModelOptions,
  type DownloadAssetOptions,
  type Tool,
  type ToolCall,
  type ToolCallWithCall,
  type ToolCallError,
  type ToolCallEvent,
  type CompletionEvent,
  type CompletionFinal,
  type CompletionRun,
  type CompletionStats,
  type EmbedStats,
  VERBOSITY,
  type Attachment,
  type TranscribeStreamSession,
  type TranscribeStreamMetadataSession,
  type TranscribeStreamConversationSession,
  type TranscribeStreamEvent,
  type VadStateEvent,
  type EndOfTurnEvent,
  type TranscribeSegment,
  type TextToSpeechStreamSession,
  type TextToSpeechStreamResponse,
  type TextToSpeechStreamClientParams,
  type CompletionParams,
  type ToolDialect,
  type RagSearchResult,
  type RagSaveEmbeddingsResult,
  type RagReindexResult,
  type RagEmbeddedDoc,
  type RagDoc,
  type RagWorkspaceInfo,
  type RagCloseWorkspaceParams,
  type RagDeleteWorkspaceParams,
  type RagIngestStage,
  type RagReindexStage,
  type RagSaveStage,
  SDK_CLIENT_ERROR_CODES,
  SDK_SERVER_ERROR_CODES,
  type QvacConfig,
  type ModelInfo,
  type GetModelInfoParams,
  type GetLoadedModelInfoParams,
  type LoadedModelInfo,
  type LoadedInstance,
  type CacheFileInfo,
  toolSchema,
  TOOLS_MODE,
  type ToolsMode,
  type McpClient,
  type McpClientInput,
  type OCRClientParams,
  type OCRTextBlock,
  type OCROptions,
  type ClassifyClientParams,
  type ClassificationResult,
  type DiffusionClientParams,
  type DiffusionStreamResponse,
  type DiffusionStats,
  type VideoClientParams,
  type VideoStreamResponse,
  type VideoStats,
  type UpscaleClientParams,
  type UpscaleStreamResponse,
  type UpscaleStats,
  type VlaConfig,
  type VlaClientRunParams,
  type VlaClientRunResult,
  type VlaHparams,
  type VlaStats,
  definePlugin,
  defineHandler,
  defineDuplexHandler,
  type QvacPlugin,
  type CreateModelParams,
  type PluginModelResult,
  type ModelRegistryEntry,
  type ModelRegistryEntryAddon,
  PLUGIN_LLM,
  PLUGIN_EMBEDDING,
  PLUGIN_WHISPER,
  PLUGIN_NMT,
  PLUGIN_TTS,
  PLUGIN_OCR,
  PLUGIN_DIFFUSION,
  PLUGIN_VLA,
  PLUGIN_CLASSIFICATION,
  SDK_DEFAULT_PLUGINS,
  type BuiltinPlugin,
  type ProfilerMode,
  type FinetuneValidation,
  type FinetuneRunParams,
  type FinetuneGetStateParams,
  type FinetuneStopParams,
  type FinetuneParams,
  type FinetuneStatus,
  type FinetuneProgress,
  type FinetuneStats,
  type FinetuneResult,
} from "./schemas";

export { type ToolInput, type ToolHandler } from "./utils/tool-helpers";

// Model types - canonical naming with backward-compatible aliases
export { MODEL_TYPES, ModelType } from "./schemas";

// Model registry constants
export * from "./models/registry";

export { SUPPORTED_AUDIO_FORMATS } from "./constants/audio";

// Error classes that clients need for `instanceof` checks on rejected
// promises. `InferenceCancelledError` rides the standard `QvacError`
// envelope, but consumers reach for it through `instanceof` on
// `await run.final` / `run.text` / `run.toolCalls` / `run.stats`
// rejections. `RequestRejectedByPolicyError` is thrown by
// `RequestRegistry.begin(...)` when a registered concurrency policy
// (e.g. `oneAtATimePerModel` on `completion`) rejects a new request;
// it propagates out through the worker so the client can distinguish
// "the request collided with another one" from "the request failed".
//
// `RequestIdConflictError` and `RequestNotFoundError` are thrown by
// `RequestRegistry.begin(...)` / `.end(...)` on UUID collisions and
// missing-target cancels. They're surfaced here so consumers using
// the decorated-promise `requestId` can pattern-match on rejected
// cancel paths. All three classes round-trip the RPC boundary via
// the typed-error reconstructor in `client/rpc/rpc-error.ts` so
// `err instanceof <Class>` works on the consumer side, not just on
// the worker side.
export { InferenceCancelledError } from "./utils/errors-server";
export type { InferenceCancelledPartial } from "./utils/errors-server";
export {
  RequestIdConflictError,
  RequestNotFoundError,
  RequestRejectedByPolicyError,
} from "./utils/errors-server";

// Logging exports
export { getLogger, SDK_LOG_ID } from "./logging";
export type { Logger, LogTransport, LoggerOptions } from "./logging";

// Profiler exports
export { profiler } from "./profiling";
export type { ProfilerRuntimeOptions, ProfilerExport } from "./profiling";
