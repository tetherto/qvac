import { handleCompletionStream } from './completion-stream'
import { handleDownloadAsset } from '../../handlers/download-asset'
import { handleLoadModel } from '../../handlers/load-model'
import { handleUnloadModel } from '../../handlers/unload-model'
import { handleEmbed } from './embed'
import { handleTranscribe } from './transcribe'
import { handleTranscribeStream } from './transcribe-stream'
import { handleBciTranscribe } from './bci-transcribe'
import { handleBciTranscribeStream } from './bci-transcribe-stream'
import { provideHandler } from '../../p2p/provideHandler'
import { stopProvideHandler } from '../../p2p/stopProvideHandler'
import { handleTranslate } from './translate'
import { handleLoggingStream } from '../../handlers/logging-stream'
import { handleRag } from '../../rag/handler'
import { cancelHandler } from '../../handlers/cancelHandler'
import { handleDeleteCache } from '../../handlers/delete-cache'
import { handleTextToSpeech } from './text-to-speech'
import { handleTextToSpeechStream } from './text-to-speech-stream'
import { handleGetModelInfo } from '../../handlers/get-model-info'
import { handleGetLoadedModelInfo } from '../../handlers/get-loaded-model-info'
import { handleFinetune } from '../../handlers/finetune'
import { handleOCRStream } from './ocr-stream'
import { handleHeartbeat } from '../../handlers/heartbeat'
import { handleDiffusionStream } from './diffusion-stream'
import { handleVideoStream } from './video-stream'
import { handleUpscaleStream } from './upscale-stream'
import { handlePluginInvoke, handlePluginInvokeStream } from '../../handlers/plugin-invoke'
import {
  handleModelRegistryList,
  handleModelRegistrySearch,
  handleModelRegistryGetModel
} from '../../handlers/registry'
import { handleSuspend } from '../../handlers/suspend'
import { handleResume } from '../../handlers/resume'
import { handleState } from '../../handlers/state'

export const handlers = {
  heartbeat: handleHeartbeat,
  completionStream: handleCompletionStream,
  downloadAsset: handleDownloadAsset,
  deleteCache: handleDeleteCache,
  loadModel: handleLoadModel,
  unloadModel: handleUnloadModel,
  embed: handleEmbed,
  transcribe: handleTranscribe,
  transcribeStream: handleTranscribeStream,
  bciTranscribe: handleBciTranscribe,
  bciTranscribeStream: handleBciTranscribeStream,
  provide: provideHandler,
  stopProvide: stopProvideHandler,
  translate: handleTranslate,
  loggingStream: handleLoggingStream,
  rag: handleRag,
  cancel: cancelHandler,
  textToSpeech: handleTextToSpeech,
  textToSpeechStream: handleTextToSpeechStream,
  getModelInfo: handleGetModelInfo,
  getLoadedModelInfo: handleGetLoadedModelInfo,
  finetune: handleFinetune,
  ocrStream: handleOCRStream,
  diffusionStream: handleDiffusionStream,
  videoStream: handleVideoStream,
  upscaleStream: handleUpscaleStream,
  pluginInvoke: handlePluginInvoke,
  pluginInvokeStream: handlePluginInvokeStream,
  modelRegistryList: handleModelRegistryList,
  modelRegistrySearch: handleModelRegistrySearch,
  modelRegistryGetModel: handleModelRegistryGetModel,
  suspend: handleSuspend,
  resume: handleResume,
  state: handleState
}
