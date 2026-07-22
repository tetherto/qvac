import { type Request } from './schemas/index.ts'
import { dispatchPluginReply, dispatchPluginStream } from './handlers/plugin-dispatch.ts'
import { getModelEntry } from './runtime/model-registry.ts'
import { handleLoadModel } from './handlers/load-model/index.ts'
import { handleLoadModelDelegated } from './p2p/load-model-delegated.ts'
import { handleCompletionStreamDelegated } from './p2p/completion-stream-delegated.ts'
import { handleUnloadModel } from './handlers/unload-model.ts'
import { handleUnloadModelDelegated } from './p2p/unload-model-delegated.ts'
import { handleLoggingStream } from './handlers/logging-stream.ts'
import { cancelHandler } from './handlers/cancelHandler.ts'
import { provideHandler } from './p2p/provideHandler.ts'
import { stopProvideHandler } from './p2p/stopProvideHandler.ts'
import { handleRag } from './rag/handler.ts'
import { handleDeleteCache } from './handlers/delete-cache.ts'
import { handleDownloadAsset } from './handlers/download-asset.ts'
import { handleGetModelInfo } from './handlers/get-model-info.ts'
import { handleGetLoadedModelInfo } from './handlers/get-loaded-model-info.ts'
import { handleHeartbeat } from './handlers/heartbeat.ts'
import { handleHeartbeatDelegated } from './p2p/heartbeat-delegated.ts'
import { handleFinetune } from './handlers/finetune.ts'
import { handleCancelDelegated } from './p2p/cancel-delegated.ts'
import { handlePluginInvoke, handlePluginInvokeStream } from './handlers/plugin-invoke.ts'
import {
  handleModelRegistryList,
  handleModelRegistrySearch,
  handleModelRegistryGetModel
} from './handlers/registry.ts'
import { handleSuspend } from './handlers/suspend.ts'
import { handleResume } from './handlers/resume.ts'
import { handleState } from './handlers/state.ts'
import type {
  HandlerEntry,
  ReplyHandler,
  StreamHandler,
  DuplexStreamHandler
} from './handlers/types.ts'

// Capability handlers route a request to whichever plugin serves the loaded
// model's type. Every model capability shares this shape, so one factory each
// for reply/stream/duplex stands in for a file per capability.
function pluginReply(capability: string): ReplyHandler {
  return (request) => dispatchPluginReply(request.modelId, capability, request)
}

function pluginStream(capability: string): StreamHandler {
  return (request) => dispatchPluginStream(request.modelId, capability, request)
}

function pluginDuplex(capability: string): DuplexStreamHandler {
  return (request, inputStream) =>
    dispatchPluginStream(request.modelId, capability, request, inputStream)
}

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
 *  - `request` — targeted cancel by `requestId`. Always handled locally: the
 *    process-singleton `RequestRegistry` is the source of truth for active
 *    requests (delegated handlers register their own requests on it the same
 *    way local ones do), so a `requestId` cancel always lands on the right
 *    place without a hop through the provider. Returning `false` keeps it on
 *    the local cancel handler, which routes through the registry and (for
 *    downloads) the `markClearCacheForRequest` helper.
 *
 *  - `broad` — abort every in-flight request on a model. Forwarded to the
 *    delegated provider iff the targeted model itself is delegated; the
 *    provider then runs the same broad-cancel sweep on its side. Broad cancels
 *    for non-delegated models stay local.
 */
function isCancelDelegated(request: Request): boolean {
  if (request.type !== 'cancel') return false
  if (request.operation !== 'broad') return false
  return isModelDelegated(request)
}

export const registry: Record<string, HandlerEntry> = {
  // Reply
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
  embed: { type: 'reply', pluginOp: true, handler: pluginReply('embed') },
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
  modelRegistryGetModel: { type: 'reply', handler: handleModelRegistryGetModel },
  suspend: { type: 'reply', handler: handleSuspend },
  resume: { type: 'reply', handler: handleResume },
  state: { type: 'reply', handler: handleState },
  loadModel: {
    type: 'reply',
    handler: handleLoadModel,
    delegatedHandler: handleLoadModelDelegated,
    isDelegated: (r) => r.type === 'loadModel' && !!r.delegate,
    supportsProgress: true
  },
  downloadAsset: { type: 'reply', handler: handleDownloadAsset, supportsProgress: true },
  rag: { type: 'reply', handler: handleRag, supportsProgress: ragSupportsProgress },
  finetune: { type: 'reply', handler: handleFinetune, supportsProgress: finetuneSupportsProgress },

  // Stream
  completionStream: {
    type: 'stream',
    pluginOp: true,
    handler: pluginStream('completionStream'),
    delegatedHandler: handleCompletionStreamDelegated,
    isDelegated: isModelDelegated
  },
  batchCompletionStream: {
    type: 'stream',
    pluginOp: true,
    handler: pluginStream('batchCompletionStream')
  },
  transcribe: { type: 'stream', pluginOp: true, handler: pluginStream('transcribe') },
  bciTranscribe: { type: 'stream', pluginOp: true, handler: pluginStream('bciTranscribe') },
  translate: { type: 'stream', pluginOp: true, handler: pluginStream('translate') },
  textToSpeech: { type: 'stream', pluginOp: true, handler: pluginStream('textToSpeech') },
  ocrStream: { type: 'stream', pluginOp: true, handler: pluginStream('ocrStream') },
  diffusionStream: { type: 'stream', pluginOp: true, handler: pluginStream('diffusionStream') },
  videoStream: { type: 'stream', pluginOp: true, handler: pluginStream('videoStream') },
  upscaleStream: { type: 'stream', pluginOp: true, handler: pluginStream('upscaleStream') },
  classify: { type: 'stream', pluginOp: true, handler: pluginStream('classify') },
  loggingStream: { type: 'stream', handler: handleLoggingStream },
  pluginInvokeStream: { type: 'stream', handler: handlePluginInvokeStream },

  // Duplex
  transcribeStream: { type: 'duplex', pluginOp: true, handler: pluginDuplex('transcribeStream') },
  bciTranscribeStream: {
    type: 'duplex',
    pluginOp: true,
    handler: pluginDuplex('bciTranscribeStream')
  },
  textToSpeechStream: {
    type: 'duplex',
    pluginOp: true,
    handler: pluginDuplex('textToSpeechStream')
  }
}
