import type {
  CloseSessionRequest,
  OpenSessionRequest,
  RPCOptions,
  AbortableRPCOptions
} from '@qvac/inference/surface'
import * as api from '@/client/api'
import { send } from '@/client/rpc/rpc-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import {
  endSession,
  isModelHeldBySession,
  isSessionEnded,
  recordHeldModel,
  registerSession,
  releaseHeldModel
} from '@/client/session-registry'
import { InvalidResponseError, SessionInvalidatedError } from '@/utils/errors-client'

export interface OpenSessionOptions {
  /** Label for worker logs and diagnostics. */
  name?: string
}

type Api = typeof api

/**
 * A caller session on the shared runtime. It has the same methods as the
 * module-level SDK; every call made through it carries the session id, so:
 *
 * - `cancel` only reaches this session's requests;
 * - `loadModel` takes a lease on the model, and `unloadModel` releases only
 *   this session's lease;
 * - `close()` cancels the session's requests and releases its leases.
 *
 * A session never shuts the runtime down. Only the module-level `close()`,
 * the owner's call, does that, and it ends every session with it.
 */
export interface QvacSession {
  readonly sessionId: string
  readonly name: string | undefined
  /** Resolves once the worker has registered the session. Calls queue behind it on their own. */
  readonly opened: Promise<void>
  /** Whether this session loaded `modelId` and has not unloaded it. */
  isModelHeld(modelId: string): boolean
  /** Cancels the session's requests, releases its model leases and ends the handle. */
  close(options?: RPCOptions): Promise<void>

  loadModel: Api['loadModel']
  downloadAsset: Api['downloadAsset']
  unloadModel: Api['unloadModel']
  completion: Api['completion']
  batchCompletion: Api['batchCompletion']
  embed: Api['embed']
  decide: Api['decide']
  rerank: Api['rerank']
  transcribe: Api['transcribe']
  transcribeStream: Api['transcribeStream']
  bciTranscribe: Api['bciTranscribe']
  bciTranscribeStream: Api['bciTranscribeStream']
  translate: Api['translate']
  textToSpeech: Api['textToSpeech']
  textToSpeechStream: Api['textToSpeechStream']
  finetune: Api['finetune']
  cancel: Api['cancel']
  ragChunk: Api['ragChunk']
  ragIngest: Api['ragIngest']
  ragSaveEmbeddings: Api['ragSaveEmbeddings']
  ragSearch: Api['ragSearch']
  ragDeleteEmbeddings: Api['ragDeleteEmbeddings']
  ragReindex: Api['ragReindex']
  ragListWorkspaces: Api['ragListWorkspaces']
  ragCloseWorkspace: Api['ragCloseWorkspace']
  ragDeleteWorkspace: Api['ragDeleteWorkspace']
  createVectorIndex: Api['createVectorIndex']
  loadVectorIndex: Api['loadVectorIndex']
  ocr: Api['ocr']
  classify: Api['classify']
  diffusion: Api['diffusion']
  upscale: Api['upscale']
  video: Api['video']
  worldCreateScene: Api['worldCreateScene']
  worldStep: Api['worldStep']
  audioGen: Api['audioGen']
  audioEdit: Api['audioEdit']
  audioUnderstand: Api['audioUnderstand']
  vla: Api['vla']
  vlaHparams: Api['vlaHparams']
  vlaSetEmbodiment: Api['vlaSetEmbodiment']
  invokePlugin: Api['invokePlugin']
  invokePluginStream: Api['invokePluginStream']
  deleteCache: Api['deleteCache']
  getModelInfo: Api['getModelInfo']
  getLoadedModelInfo: Api['getLoadedModelInfo']
  getSystemResources: Api['getSystemResources']
  assessModelFit: Api['assessModelFit']
  heartbeat: Api['heartbeat']
  loggingStream: Api['loggingStream']
  subscribeServerLogs: Api['subscribeServerLogs']
  modelRegistryList: Api['modelRegistryList']
  modelRegistrySearch: Api['modelRegistrySearch']
  modelRegistryGetModel: Api['modelRegistryGetModel']
  suspend: Api['suspend']
  resume: Api['resume']
  state: Api['state']
  startRpcServer: Api['startRpcServer']
  stopRpcServer: Api['stopRpcServer']
  discoverRpcServers: Api['discoverRpcServers']
}

/**
 * Opens a caller session on the runtime and returns its handle at once. The
 * `openSession` round trip runs in the background; calls made on the handle
 * wait for it, so the handle is usable immediately.
 *
 * @param options - `name` labels the session in worker logs.
 * @returns The session handle.
 * @throws {SessionIdConflictError} Through `session.opened` and every call,
 *   when the worker already has a session with the minted id.
 *
 * @example
 * ```typescript
 * const a = openSession({ name: 'harness' })
 * const b = openSession({ name: 'skill-runner' })
 * const modelId = await a.loadModel({ modelSrc: QWEN3_600M_INST_Q4 })
 * await b.loadModel({ modelSrc: QWEN3_600M_INST_Q4 }) // same model, second lease
 * const run = a.completion({ modelId, history: [...] })
 * await b.cancel({ requestId: run.requestId }) // cancelled: 0, the run continues
 * await a.close()                               // releases a's lease, the model stays for b
 * ```
 */
export function openSession(options: OpenSessionOptions = {}): QvacSession {
  const sessionId = generateClientRequestId()
  const name = options.name
  const opened = sendOpenSession({ type: 'openSession', sessionId, ...(name && { name }) })
  // Later calls surface the failure themselves; an unobserved rejection here
  // must not crash the host.
  opened.catch(() => {})
  registerSession(sessionId, opened)
  return createSessionHandle(sessionId, name, opened)
}

async function sendOpenSession(request: OpenSessionRequest): Promise<void> {
  const response = await send(request)
  if (response.type !== 'openSession') throw new InvalidResponseError('openSession')
}

function createSessionHandle(
  sessionId: string,
  name: string | undefined,
  opened: Promise<void>
): QvacSession {
  // Session-stamped options for every wire call made through the handle. A
  // caller's own options are kept; `sessionId` is set by the handle.
  const withSession = <T extends RPCOptions | AbortableRPCOptions | undefined>(options: T) =>
    ({ ...options, sessionId }) as NonNullable<T>

  // `loadModel` is overloaded, so its parameter type is not contextually
  // available; the public type is restored by the cast.
  const loadModel = ((options: unknown, rpcOptions?: RPCOptions) => {
    const load = api.loadModel(options as never, withSession(rpcOptions))
    load.then((modelId) => recordHeldModel(sessionId, modelId)).catch(() => {})
    return load
  }) as Api['loadModel']

  const unloadModel: Api['unloadModel'] = async (params, options) => {
    const result = await api.unloadModel(params, withSession(options))
    if (result.released) releaseHeldModel(sessionId, params.modelId)
    return result
  }

  async function close(options?: RPCOptions): Promise<void> {
    if (isSessionEnded(sessionId)) throw new SessionInvalidatedError(sessionId, 'closed')
    await opened
    const request: CloseSessionRequest = { type: 'closeSession', sessionId }
    const response = await send(request, options)
    if (response.type !== 'closeSession') throw new InvalidResponseError('closeSession')
    endSession(sessionId, 'closed')
  }

  return {
    sessionId,
    name,
    opened,
    isModelHeld: (modelId) => isModelHeldBySession(sessionId, modelId),
    close,

    loadModel,
    unloadModel,
    downloadAsset: (options, rpcOptions) => api.downloadAsset(options, withSession(rpcOptions)),
    completion: (params) =>
      api.completion({ ...params, rpcOptions: withSession(params.rpcOptions) }),
    batchCompletion: (params) =>
      api.batchCompletion({ ...params, rpcOptions: withSession(params.rpcOptions) }),
    embed: ((params, options) =>
      api.embed(params as Parameters<Api['embed']>[0], withSession(options))) as Api['embed'],
    decide: ((params, options) =>
      api.decide(params as Parameters<Api['decide']>[0], withSession(options))) as Api['decide'],
    rerank: (params, options) => api.rerank(params, withSession(options)),
    transcribe: ((params, options) =>
      api.transcribe(
        params as Parameters<Api['transcribe']>[0],
        withSession(options)
      )) as Api['transcribe'],
    transcribeStream: ((params, options) =>
      api.transcribeStream(
        params as Parameters<Api['transcribeStream']>[0],
        withSession(options)
      )) as Api['transcribeStream'],
    bciTranscribe: ((params, options) =>
      api.bciTranscribe(
        params as Parameters<Api['bciTranscribe']>[0],
        withSession(options)
      )) as Api['bciTranscribe'],
    bciTranscribeStream: ((params, options) =>
      api.bciTranscribeStream(
        params as Parameters<Api['bciTranscribeStream']>[0],
        withSession(options)
      )) as Api['bciTranscribeStream'],
    translate: (params, options) => api.translate(params, withSession(options)),
    textToSpeech: (params, options) => api.textToSpeech(params, withSession(options)),
    textToSpeechStream: (params, options) => api.textToSpeechStream(params, withSession(options)),
    finetune: ((params, options) =>
      api.finetune(
        params as Parameters<Api['finetune']>[0],
        withSession(options)
      )) as Api['finetune'],
    cancel: (params, options) => api.cancel(params, withSession(options)),
    ragChunk: (params, options) => api.ragChunk(params, withSession(options)),
    ragIngest: (params, options) => api.ragIngest(params, withSession(options)),
    ragSaveEmbeddings: (params, options) => api.ragSaveEmbeddings(params, withSession(options)),
    ragSearch: (params, options) => api.ragSearch(params, withSession(options)),
    ragDeleteEmbeddings: (params, options) => api.ragDeleteEmbeddings(params, withSession(options)),
    ragReindex: (params, options) => api.ragReindex(params, withSession(options)),
    ragListWorkspaces: (options) => api.ragListWorkspaces(withSession(options)),
    ragCloseWorkspace: (params, options) => api.ragCloseWorkspace(params, withSession(options)),
    ragDeleteWorkspace: (params, options) => api.ragDeleteWorkspace(params, withSession(options)),
    createVectorIndex: (params, options) => api.createVectorIndex(params, withSession(options)),
    loadVectorIndex: (params, options) => api.loadVectorIndex(params, withSession(options)),
    ocr: (params, options) => api.ocr(params, withSession(options)),
    classify: (params, options) => api.classify(params, withSession(options)),
    diffusion: (params, options) => api.diffusion(params, withSession(options)),
    upscale: (params, options) => api.upscale(params, withSession(options)),
    video: (params, options) => api.video(params, withSession(options)),
    worldCreateScene: ((params, options) =>
      api.worldCreateScene(
        params as Parameters<Api['worldCreateScene']>[0],
        withSession(options)
      )) as Api['worldCreateScene'],
    worldStep: (params, options) => api.worldStep(params, withSession(options)),
    audioGen: (params, options) => api.audioGen(params, withSession(options)),
    audioEdit: (params, options) => api.audioEdit(params, withSession(options)),
    audioUnderstand: (params, options) => api.audioUnderstand(params, withSession(options)),
    vla: (params, options) => api.vla(params, withSession(options)),
    vlaHparams: (params, options) => api.vlaHparams(params, withSession(options)),
    vlaSetEmbodiment: (params, options) => api.vlaSetEmbodiment(params, withSession(options)),
    invokePlugin: (options, rpcOptions) => api.invokePlugin(options, withSession(rpcOptions)),
    invokePluginStream: (options, rpcOptions) =>
      api.invokePluginStream(options, withSession(rpcOptions)),
    deleteCache: (params, options) => api.deleteCache(params, withSession(options)),
    getModelInfo: (params, options) => api.getModelInfo(params, withSession(options)),
    getLoadedModelInfo: (params, options) => api.getLoadedModelInfo(params, withSession(options)),
    getSystemResources: (input, options) => api.getSystemResources(input, withSession(options)),
    assessModelFit: (input, options) => api.assessModelFit(input, withSession(options)),
    heartbeat: (options) => api.heartbeat(withSession(options)),
    loggingStream: (params, options) => api.loggingStream(params, withSession(options)),
    subscribeServerLogs: (handler, options) =>
      api.subscribeServerLogs(handler, withSession(options)),
    modelRegistryList: (options) => api.modelRegistryList(withSession(options)),
    modelRegistrySearch: (params, options) => api.modelRegistrySearch(params, withSession(options)),
    modelRegistryGetModel: (registryPath, registrySource, options) =>
      api.modelRegistryGetModel(registryPath, registrySource, withSession(options)),
    suspend: (options) => api.suspend(withSession(options)),
    resume: (options) => api.resume(withSession(options)),
    state: (options) => api.state(withSession(options)),
    startRpcServer: (options, rpcOptions) => api.startRpcServer(options, withSession(rpcOptions)),
    stopRpcServer: (options, rpcOptions) => api.stopRpcServer(options, withSession(rpcOptions)),
    discoverRpcServers: (options, rpcOptions) =>
      api.discoverRpcServers(options, withSession(rpcOptions))
  }
}
