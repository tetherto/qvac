// Public API exports only
export {
  batchCompletion,
  completion,
  deleteCache,
  loadModel,
  downloadAsset,
  heartbeat,
  unloadModel,
  transcribe,
  transcribeStream,
  bciTranscribe,
  bciTranscribeStream,
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
  getSystemResources,
  assessModelFit,
  loggingStream,
  subscribeServerLogs,
  type ServerLogHandler,
  ocr,
  invokePlugin,
  invokePluginStream,
  diffusion,
  type DiffusionProgressTick,
  classify,
  video,
  type VideoProgressTick,
  upscale,
  worldCreateScene,
  worldStep,
  type WorldStepResult,
  type WorldStepProgressTick,
  type WorldSceneResult,
  type WorldSceneResultWithPack,
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
  type ModelRegistrySearchParams,
  suspend,
  resume,
  state,
  vla,
  vlaHparams,
  vlaSetEmbodiment,
  vlaPreprocessImage,
  vlaPadState,
  VLA_DEFAULT_IMAGE_SIZE,
  audioGen,
  type FinetuneHandle
} from './client/api'
export { close } from './client'
export { plugins } from './client/plugins-factory'
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
  type TranscribeStats,
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
  type TtsClientParamsInput,
  type TtsParlerEmotion,
  type TtsParlerLoadConfig,
  type TtsParlerRuntimeConfig,
  TTS_PACES,
  TTS_COSYVOICE3_EMOTIONS,
  TTS_COSYVOICE3_INSTRUCT_DIALECTS,
  TTS_COSYVOICE3_INSTRUCT_VOLUMES,
  TTS_COSYVOICE3_INSTRUCT_STYLES,
  type TtsPace,
  type TtsCosyvoice3Emotion,
  type TtsCosyvoice3Instruct,
  type TtsCosyvoice3LoadConfig,
  type TtsCosyvoice3RuntimeConfig,
  type TtsAudio8LoadConfig,
  type TtsAudio8RuntimeConfig,
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
  type AssessModelFitInput,
  type AssessModelFitResult,
  type LoadedInstance,
  type CacheFileInfo,
  toolSchema,
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
  AUDIOGEN_TASK_TYPES,
  AUDIOGEN_INPUT_SAMPLE_RATE,
  AUDIOGEN_INPUT_CHANNELS,
  AUDIOGEN_INPUT_MAX_SECONDS,
  type AudioGenTaskType,
  type AudioGenAudioInput,
  type AudioGenClientParams,
  type AudioGenConfig,
  type AudioGenRuntimeConfig,
  type AudioGenProgress,
  type AudioGenAudio,
  type AudioGenStats,
  type AudioGenResult,
  type AudioGenStreamResponse,
  type VideoClientParams,
  type VideoStreamResponse,
  type VideoStats,
  type UpscaleClientParams,
  type UpscaleStreamResponse,
  type UpscaleStats,
  type WalkKey,
  type WalkKeysInput,
  type WorldStepClientParams,
  type WorldStepStreamResponse,
  type WorldStepStats,
  type WorldSceneClientParams,
  type WorldSceneStreamResponse,
  type WorldSceneStats,
  type VlaConfig,
  type VlaClientRunParams,
  type VlaClientRunResult,
  type VlaEmbodimentSelection,
  type VlaEmbodimentSelector,
  type VlaHparams,
  type VlaStats,
  definePlugin,
  defineHandler,
  defineDuplexHandler,
  PluginDefinitionInvalidError,
  type QvacPlugin,
  type CreateModelParams,
  type PluginModelResult,
  type ModelRegistryEntry,
  type ModelRegistryEntryAddon,
  type ProfilerMode,
  type FinetuneValidation,
  type FinetuneRunParams,
  type FinetuneGetStateParams,
  type FinetuneStopParams,
  type FinetuneParams,
  type FinetuneStatus,
  type FinetuneProgress,
  type FinetuneStats,
  type FinetuneResult
} from '@qvac/inference/surface'

// SDK-owned error-code objects: `SDK_CLIENT_ERROR_CODES` holds transport/client
// codes absent from @qvac/inference, and `SDK_SERVER_ERROR_CODES` carries the
// client-side error definitions (`addCodes` message registry) that
// @qvac/inference's value-clean surface does not provide.
export { SDK_CLIENT_ERROR_CODES } from '@/schemas/sdk-errors-client'
export { SDK_SERVER_ERROR_CODES } from '@/schemas/sdk-errors-server'

// Built-in plugin ids under the public @qvac/sdk name (see `@/plugin-ids`).
export {
  PLUGIN_LLM,
  PLUGIN_EMBEDDING,
  PLUGIN_WHISPER,
  PLUGIN_BCI,
  PLUGIN_NMT,
  PLUGIN_TTS,
  PLUGIN_OCR,
  PLUGIN_DIFFUSION,
  PLUGIN_AUDIOGEN,
  PLUGIN_VLA,
  PLUGIN_CLASSIFICATION,
  SDK_DEFAULT_PLUGINS,
  type BuiltinPlugin
} from '@/plugin-ids'

export { type ToolInput, type ToolHandler } from './utils/tool-helpers'

// Model types - canonical naming with backward-compatible aliases
export { MODEL_TYPES, ModelType } from '@qvac/inference/surface'

// Model registry constants
export * from '@qvac/inference/models'

export { SUPPORTED_AUDIO_FORMATS } from '@qvac/inference/surface'

// Error classes that clients need for `instanceof` checks on rejected
// promises. `InferenceCancelledError` rides the standard `QvacError`
// envelope, but consumers reach for it through `instanceof` on
// `await run.final` / `run.text` / `run.toolCalls` / `run.stats`
// rejections. `RequestRejectedByPolicyError` is thrown by
// `await RequestRegistry.begin(...)` when a registered concurrency policy
// refuses a new request. A same-model `completion` doesn't reject — it waits
// FIFO — so this surfaces only when the per-model wait queue is already at its
// `maxQueueDepthPerModel` cap. It propagates out through the worker so the
// client can distinguish "the model is saturated" from "the request failed".
//
// `RequestIdConflictError` and `RequestNotFoundError` are thrown by
// `await RequestRegistry.begin(...)` / `.end(...)` on UUID collisions and
// missing-target cancels. They're surfaced here so consumers using
// the decorated-promise `requestId` can pattern-match on rejected
// cancel paths. All three classes round-trip the RPC boundary via
// the typed-error reconstructor in `client/rpc/rpc-error.ts` so
// `err instanceof <Class>` works on the consumer side, not just on
// the worker side.
export { InferenceCancelledError } from './utils/errors-server'
export type { InferenceCancelledPartial } from './utils/errors-server'
export {
  ContextOverflowError,
  RequestIdConflictError,
  RequestNotFoundError,
  RequestRejectedByPolicyError,
  TranslationFailedError
} from './utils/errors-server'

// `WorkerCrashedError` and `WorkerShutdownError` are thrown by the
// rpc-client life-signal race when the bare worker exits unexpectedly
// or close()/process-exit teardown runs while a caller is in flight.
// `BareRuntimeBinaryNotFoundError` is thrown when the worker fails to
// spawn because the platform's `bare-runtime-<platform>-<arch>` package is
// missing (common under pnpm). Exported so consumers can pattern-match with
// `instanceof`.
// `StreamEndedError` is raised by the streaming result helpers (upscale, world)
// when the RPC stream closes without a terminal `done` frame. Exported for the
// same reason as the rest of this block: matching on it requires the class.
export {
  BareRuntimeBinaryNotFoundError,
  WorkerCrashedError,
  WorkerShutdownError,
  RequestValidationFailedError,
  StreamEndedError
} from './utils/errors-client'

// Logging exports
export { getLogger, SDK_LOG_ID, SDK_ALL_LOG_ID } from './logging'
export type { Logger, LogTransport, LoggerOptions } from './logging'

// Profiler exports
export { profiler, attachBackendDiagnostics } from '@qvac/inference/surface'
export type {
  ProfilerRuntimeOptions,
  ProfilerExport,
  ProfilingEvent,
  ProfilerGPUResourceGauge,
  ProfilerResourceGauge
} from '@qvac/inference/surface'
