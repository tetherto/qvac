import { type Request } from '@/schemas/index'
import { dispatchPluginReply, dispatchPluginStream } from '@/handlers/plugin-dispatch'
import { handleLoadModel } from '@/handlers/load-model/index'
import { handleUnloadModel } from '@/handlers/unload-model'
import { handleLoggingStream } from '@/handlers/logging-stream'
import { cancelHandler } from '@/handlers/cancelHandler'
import { handleRag } from '@/rag/handler'
import { handleDeleteCache } from '@/handlers/delete-cache'
import { handleDownloadAsset } from '@/handlers/download-asset'
import { handleGetModelInfo } from '@/handlers/get-model-info'
import { handleGetLoadedModelInfo } from '@/handlers/get-loaded-model-info'
import { handleGetSystemResources } from '@/handlers/get-system-resources'
import { handleHeartbeat } from '@/handlers/heartbeat'
import { handleFinetune } from '@/handlers/finetune'
import { handleCompletionOrchestrate } from '@/handlers/completion-orchestrate'
import { handlePluginInvoke, handlePluginInvokeStream } from '@/handlers/plugin-invoke'
import {
  handleModelRegistryList,
  handleModelRegistrySearch,
  handleModelRegistryGetModel
} from '@/handlers/registry'
import { handleSuspend } from '@/handlers/suspend'
import { handleResume } from '@/handlers/resume'
import { handleState } from '@/handlers/state'
import type {
  HandlerEntry,
  ReplyHandler,
  StreamHandler,
  DuplexStreamHandler
} from '@/handlers/types'

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

export const registry: Record<string, HandlerEntry> = {
  // Reply
  heartbeat: {
    type: 'reply',
    handler: handleHeartbeat
  },
  unloadModel: {
    type: 'reply',
    handler: handleUnloadModel
  },
  embed: { type: 'reply', pluginOp: true, handler: pluginReply('embed') },
  cancel: {
    type: 'reply',
    handler: cancelHandler
  },
  deleteCache: { type: 'reply', handler: handleDeleteCache },
  getModelInfo: { type: 'reply', handler: handleGetModelInfo },
  getLoadedModelInfo: { type: 'reply', handler: handleGetLoadedModelInfo },
  getSystemResources: { type: 'reply', handler: handleGetSystemResources },
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
    supportsProgress: true
  },
  downloadAsset: { type: 'reply', handler: handleDownloadAsset, supportsProgress: true },
  rag: { type: 'reply', handler: handleRag, supportsProgress: ragSupportsProgress },
  finetune: { type: 'reply', handler: handleFinetune, supportsProgress: finetuneSupportsProgress },

  // Stream
  completionStream: {
    type: 'stream',
    pluginOp: true,
    handler: pluginStream('completionStream')
  },

  completionOrchestrate: { type: 'duplex', handler: handleCompletionOrchestrate },

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
  audioGenStream: { type: 'stream', pluginOp: true, handler: pluginStream('audioGenStream') },
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
