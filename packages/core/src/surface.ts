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
} from './schemas'

export { type ToolInput, type ToolHandler } from './utils/tool-helpers'

// Model registry constants
export * from './models/registry'

export { SUPPORTED_AUDIO_FORMATS } from './constants/audio'

// Error classes consumers need for `instanceof` checks on rejected promises.
export {
  InferenceCancelledError,
  ContextOverflowError,
  RequestIdConflictError,
  RequestNotFoundError,
  RequestRejectedByPolicyError,
  RequestValidationFailedError
} from './errors'
export type { InferenceCancelledPartial } from './errors'

// Logging
export { getLogger, LOG_ID, ALL_LOG_ID } from './logging'
export type { Logger, LogTransport, LoggerOptions } from './logging'

// Profiler
export { profiler } from './profiling'
export type { ProfilerRuntimeOptions, ProfilerExport } from './profiling'
