/**
 * Call shape of every RPC method, keyed by the request `type` literal.
 *
 * This is a contract-tooling input: `scripts/export-contract.ts` loads it
 * under Node to pair each wire method with its call shape (reply / stream /
 * duplex) in the generated manifest. It stays free of engine imports so the
 * export runs under Node, where core's native `bare-*` modules cannot load.
 */
export const methodShapes = {
  assessModelFit: 'reply',
  audioGenStream: 'stream',
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
  getSystemResources: 'reply',
  heartbeat: 'reply',
  loadModel: 'reply',
  loggingStream: 'stream',
  modelRegistryGetModel: 'reply',
  modelRegistryList: 'reply',
  modelRegistrySearch: 'reply',
  ocrStream: 'stream',
  pluginInvoke: 'reply',
  pluginInvokeStream: 'stream',
  rag: 'reply',
  resume: 'reply',
  state: 'reply',
  suspend: 'reply',
  textToSpeech: 'stream',
  textToSpeechStream: 'duplex',
  transcribe: 'stream',
  transcribeStream: 'duplex',
  translate: 'stream',
  unloadModel: 'reply',
  upscaleStream: 'stream',
  videoStream: 'stream',
  worldSceneStream: 'stream',
  worldStepStream: 'stream'
} as const

export type MethodName = keyof typeof methodShapes
export type MethodCallShape = (typeof methodShapes)[MethodName]
