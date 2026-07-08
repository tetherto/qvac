import { type Request } from '../schemas'
import { handleCompletionStream } from './handlers/completion-stream'
import { handleDownloadAsset } from '../handlers/download-asset'
import { handleLoadModel } from '../handlers/load-model'
import { handleLoadModelDelegated } from '../p2p/load-model-delegated'
import { handleCompletionStreamDelegated } from '../p2p/completion-stream-delegated'
import { getModelEntry } from '../runtime/model-registry'
import { handleUnloadModel } from '../handlers/unload-model'
import { handleUnloadModelDelegated } from '../p2p/unload-model-delegated'
import { handleTranscribe } from './handlers/transcribe'
import { handleTranscribeStream } from './handlers/transcribe-stream'
import { handleBciTranscribe } from './handlers/bci-transcribe'
import { handleBciTranscribeStream } from './handlers/bci-transcribe-stream'
import { handleEmbed } from './handlers/embed'
import { handleTranslate } from './handlers/translate'
import { handleLoggingStream } from '../handlers/logging-stream'
import { cancelHandler } from '../handlers/cancelHandler'
import { provideHandler } from '../p2p/provideHandler'
import { stopProvideHandler } from '../p2p/stopProvideHandler'
import { handleRag } from '../rag/handler'
import { handleDeleteCache } from '../handlers/delete-cache'
import { handleTextToSpeech } from './handlers/text-to-speech'
import { handleTextToSpeechStream } from './handlers/text-to-speech-stream'
import { handleGetModelInfo } from '../handlers/get-model-info'
import { handleGetLoadedModelInfo } from '../handlers/get-loaded-model-info'
import { handleOCRStream } from './handlers/ocr-stream'
import { handleHeartbeat } from '../handlers/heartbeat'
import { handleFinetune } from '../handlers/finetune'
import { handleHeartbeatDelegated } from '../p2p/heartbeat-delegated'
import { handleCancelDelegated } from '../p2p/cancel-delegated'
import { handleDiffusionStream } from './handlers/diffusion-stream'
import { handleVideoStream } from './handlers/video-stream'
import { handleUpscaleStream } from './handlers/upscale-stream'
import { handleClassify } from './handlers/classify'
import { handlePluginInvoke, handlePluginInvokeStream } from '../handlers/plugin-invoke'
import {
  handleModelRegistryList,
  handleModelRegistrySearch,
  handleModelRegistryGetModel
} from '../handlers/registry'
import { handleSuspend } from '../handlers/suspend'
import { handleResume } from '../handlers/resume'
import { handleState } from '../handlers/state'
import type { HandlerEntry } from '../handlers/types'

function ragSupportsProgress(request: Request): boolean {
  if (request.type !== 'rag') return false
  return ['ingest', 'saveEmbeddings', 'reindex'].includes(request.operation)
}

function finetuneSupportsProgress(request: Request): boolean {
  if (request.type !== 'finetune') return false
  return ['start', 'resume', undefined].includes(request.operation)
}

function isModelDelegated(request: Request): boolean {
  if (!('modelId' in request)) return false
  const entry = getModelEntry(request.modelId as string)
  return entry?.isDelegated ?? false
}

/**
 * Should the cancel be forwarded to a delegated provider?
 *
 * The cancel envelope has two operations:
 *
 *  - `request` — targeted cancel by `requestId`. Always handled
 *    locally: the process-singleton `RequestRegistry` is the source of
 *    truth for active requests (delegated handlers register their own
 *    requests on it the same way local handlers do), so a `requestId`
 *    cancel always lands on the right engine without needing a hop
 *    through the provider. Returning `false` here keeps the cancel on
 *    the local cancel handler, where it routes through the registry
 *    and (for downloads) the `markClearCacheForRequest` helper.
 *
 *  - `broad` — abort every in-flight request on a model. Forwarded to
 *    the delegated provider iff the targeted model itself is
 *    delegated; the provider then runs the same broad-cancel sweep
 *    on its side. Local broad cancels for non-delegated models stay
 *    on this engine.
 */
function isCancelDelegated(request: Request): boolean {
  if (request.type !== 'cancel') return false
  if (request.operation !== 'broad') return false
  return isModelDelegated(request)
}

export const registry: Record<string, HandlerEntry> = {
  // Simple Reply handlers
  heartbeat: {
    type: 'reply',
    handler: handleHeartbeat,
    delegatedHandler: handleHeartbeatDelegated,
    isDelegated: (r) => r.type === 'heartbeat' && !!r.delegate
  },
  unloadModel: {
    type: 'reply',
    handler: handleUnloadModel,
    delegatedHandler: handleUnloadModelDelegated,
    isDelegated: isModelDelegated
  },
  embed: { type: 'reply', handler: handleEmbed },
  cancel: {
    type: 'reply',
    handler: cancelHandler,
    delegatedHandler: handleCancelDelegated,
    isDelegated: isCancelDelegated
  },
  provide: { type: 'reply', handler: provideHandler },
  stopProvide: { type: 'reply', handler: stopProvideHandler },
  deleteCache: { type: 'reply', handler: handleDeleteCache },
  getModelInfo: { type: 'reply', handler: handleGetModelInfo },
  getLoadedModelInfo: { type: 'reply', handler: handleGetLoadedModelInfo },
  pluginInvoke: { type: 'reply', handler: handlePluginInvoke },
  modelRegistryList: { type: 'reply', handler: handleModelRegistryList },
  modelRegistrySearch: { type: 'reply', handler: handleModelRegistrySearch },
  modelRegistryGetModel: {
    type: 'reply',
    handler: handleModelRegistryGetModel
  },
  suspend: { type: 'reply', handler: handleSuspend },
  resume: { type: 'reply', handler: handleResume },
  state: { type: 'reply', handler: handleState },

  // Simple Stream handlers
  transcribe: { type: 'stream', handler: handleTranscribe },
  transcribeStream: { type: 'duplex', handler: handleTranscribeStream },
  bciTranscribe: { type: 'stream', handler: handleBciTranscribe },
  bciTranscribeStream: { type: 'duplex', handler: handleBciTranscribeStream },
  loggingStream: { type: 'stream', handler: handleLoggingStream },
  translate: { type: 'stream', handler: handleTranslate },
  textToSpeech: { type: 'stream', handler: handleTextToSpeech },
  textToSpeechStream: { type: 'duplex', handler: handleTextToSpeechStream },
  ocrStream: { type: 'stream', handler: handleOCRStream },
  diffusionStream: { type: 'stream', handler: handleDiffusionStream },
  videoStream: { type: 'stream', handler: handleVideoStream },
  upscaleStream: { type: 'stream', handler: handleUpscaleStream },
  classify: { type: 'stream', handler: handleClassify },
  pluginInvokeStream: { type: 'stream', handler: handlePluginInvokeStream },

  // Handlers with delegation support
  loadModel: {
    type: 'reply',
    handler: handleLoadModel,
    delegatedHandler: handleLoadModelDelegated,
    isDelegated: (r) => r.type === 'loadModel' && !!r.delegate,
    supportsProgress: true
  },

  completionStream: {
    type: 'stream',
    handler: handleCompletionStream,
    delegatedHandler: handleCompletionStreamDelegated,
    isDelegated: isModelDelegated
  },

  // Handlers with progress support
  downloadAsset: {
    type: 'reply',
    handler: handleDownloadAsset,
    supportsProgress: true
  },

  rag: {
    type: 'reply',
    handler: handleRag,
    supportsProgress: ragSupportsProgress
  },

  finetune: {
    type: 'reply',
    handler: handleFinetune,
    supportsProgress: finetuneSupportsProgress
  }
}
