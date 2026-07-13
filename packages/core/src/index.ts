/// <reference types="bare" />

// Public API: the operations, engine lifecycle and explicit plugin assembly, and
// the value-clean surface (schemas / types / consts / errors / model registry)
// re-exported from `./surface`.
export {
  batchCompletion,
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
  type FinetuneHandle
} from './api'

// Engine lifecycle and explicit plugin assembly. Core registers no plugins by
// default: an app assembles the engines it needs via `plugins([...])` or the
// `registerPlugin`/`registerPlugins` primitives, then calls the operations.
export { close } from './dispatch'
export {
  plugins,
  registerPlugin,
  registerPlugins,
  getPlugin,
  hasPlugin,
  getAllPlugins,
  unregisterPlugin
} from './plugins'

// The value-clean surface (also published as `@qvac/core/surface`).
export * from './surface'
