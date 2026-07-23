/**
 * Call shape of every RPC method, keyed by the request `type` literal.
 *
 * This module must stay free of handler imports: the contract export
 * (`scripts/export-contract.ts`) loads it under Node, where the handler
 * graph's native bare-* modules cannot be required. `handler-registry.ts`
 * is type-bound to this map, so a registry entry whose key or `type`
 * diverges from it fails to compile.
 */
export const methodShapes = {
  batchCompletionStream: 'stream',
  bciTranscribe: 'stream',
  bciTranscribeStream: 'duplex',
  cancel: 'reply',
  classify: 'stream',
  completionOrchestrate: 'duplex',
  completionStream: 'stream',
  deleteCache: 'reply',
  diffusionStream: 'stream',
  downloadAsset: 'reply',
  embed: 'reply',
  finetune: 'reply',
  getLoadedModelInfo: 'reply',
  getModelInfo: 'reply',
  heartbeat: 'reply',
  loadModel: 'reply',
  loggingStream: 'stream',
  modelRegistryGetModel: 'reply',
  modelRegistryList: 'reply',
  modelRegistrySearch: 'reply',
  ocrStream: 'stream',
  pluginInvoke: 'reply',
  pluginInvokeStream: 'stream',
  provide: 'reply',
  rag: 'reply',
  resume: 'reply',
  state: 'reply',
  stopProvide: 'reply',
  suspend: 'reply',
  textToSpeech: 'stream',
  textToSpeechStream: 'duplex',
  transcribe: 'stream',
  transcribeStream: 'duplex',
  translate: 'stream',
  unloadModel: 'reply',
  upscaleStream: 'stream',
  videoStream: 'stream'
} as const

export type MethodName = keyof typeof methodShapes
export type MethodCallShape = (typeof methodShapes)[MethodName]
