// The value-clean surface: schemas, types, consts, error codes and classes, and
// the model registry. Every `bare-*` import here is `import type` (erased at
// build), so it pulls no runtime dependency and no engine. `index.ts` re-exports
// it alongside the engine.

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
  type BatchCompletionEvent,
  type BatchCompletionResult,
  type BatchCompletionRun,
  type BatchPrompt,
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
  type BciConfig,
  type BciTranscribeClientParams,
  type BciTranscribeStreamClientParams,
  type BciTranscribeStreamSession,
  type BciTranscribeStreamMetadataSession,
  type BciStreamOpts,
  type NeuralInput,
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
  ERROR_CODES,
  RAG_ERROR_CODES,
  type QvacConfig,
  type ModelInfo,
  type GetModelInfoParams,
  type GetLoadedModelInfoParams,
  type LoadedModelInfo,
  type GetSystemResourcesInput,
  type ResourceScope,
  type ResourceProvenance,
  type ResourceMetric,
  type GraphicsDriver,
  type GraphicsDriverCapabilities,
  type BackendProbeResult,
  type BackendDevice,
  type BackendDriver,
  type BackendFallback,
  type InferenceBackendDiagnostics,
  type CPUResourceCapabilities,
  type GPUResourceCapabilities,
  type SystemResourceCapabilities,
  type GPUResourceSample,
  type SystemResourceSample,
  type SystemResources,
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
  PLUGIN_BCI,
  PLUGIN_NMT,
  PLUGIN_TTS,
  PLUGIN_OCR,
  PLUGIN_DIFFUSION,
  PLUGIN_VLA,
  PLUGIN_CLASSIFICATION,
  BUILTIN_PLUGINS,
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
  MODEL_TYPES,
  ModelType
} from '@/schemas/index'

export { type ToolInput, type ToolHandler } from '@/utils/tool-helpers'

// The full value-clean schema, profiling, and constant barrels: the @qvac/sdk client
// and worker source every internal schema/const/profiling name from here, so it
// carries no duplicate copies. All value-clean (only erased `import type` touches
// `bare-*`), so this stays Node-safe.
export * from '@/schemas/index'
export * from '@/profiling/index'
export * from '@/constants/index'

// Value-clean helpers @qvac/sdk's registry codegen and server-side profiler reach
// for; not part of either barrel, so re-exported explicitly here.
export {
  getAddonFromEngine,
  resolveCanonicalEngine,
  ENGINE_TO_ADDON,
  LEGACY_ENGINE_TO_CANONICAL
} from '@/schemas/engine-addon-map'
export { generateProfileId } from '@/profiling/clock'
export { readModelExecutionMs } from '@/profiling/model-execution'
export { readBackendDiagnostics } from '@/profiling/backend-diagnostics'
export {
  PUBLIC_MODEL_TYPES,
  ModelTypeAliases,
  modelTypeInputSchema,
  modelTypeSchema
} from '@/schemas/model-types'

// Model registry constants
export * from '@/models/registry/index'

export { SUPPORTED_AUDIO_FORMATS } from '@/constants/audio'

// Error classes consumers need for `instanceof` checks: on rejected promises,
// and on the synchronous throws of `plugins()` / `registerPlugin` (the plugin
// group below).
export {
  InferenceCancelledError,
  ContextOverflowError,
  RequestIdConflictError,
  RequestNotFoundError,
  RequestRejectedByPolicyError,
  RequestValidationFailedError,
  ModelNotLoadedError,
  TranslationFailedError,
  PluginDefinitionInvalidError,
  PluginModelTypeReservedError,
  PluginAlreadyRegisteredError,
  PluginLoggingInvalidError
} from '@/errors/index'
export type { InferenceCancelledPartial } from '@/errors/index'

// Logging
export { getLogger, LOG_ID, ALL_LOG_ID } from '@/logging/index'
export type { Logger, LogTransport, LoggerOptions } from '@/logging/index'

// Profiler
export { profiler, attachBackendDiagnostics } from '@/profiling/index'
export type { ProfilerRuntimeOptions, ProfilerExport } from '@/profiling/index'
