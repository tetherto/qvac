import test from 'brittle'
import {
  registerModel,
  getModelEntry,
  addModelLease,
  releaseModelLease,
  getModelIdsLeasedBy,
  unregisterModel,
  type AnyModel
} from '@/runtime/model-registry'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
import { unloadModel } from '@/plugins/ops/unload-model'
import { handleUnloadModel } from '@/handlers/unload-model'
import { handleLoadModel } from '@/handlers/load-model/handler'
import { handleOpenSession, handleCloseSession } from '@/handlers/session'
import { getRequestRegistry } from '@/runtime/index'
import { clearSessions, openSession } from '@/runtime/session-registry'
import { ModelLeasedError, ModelNotLoadedError } from '@/errors'
import { ModelType } from '@/schemas'

let counter = 0
function makeId(prefix: string) {
  counter++
  return `${prefix}-${Date.now()}-${counter}`
}

function fakeModel(onUnload?: () => void): AnyModel {
  return {
    load: async () => {},
    unload: () => {
      onUnload?.()
    },
    pause: () => {},
    run: async () => ({
      iterate: async function* () {},
      await: async () => undefined,
      cancel: async () => {}
    }),
    reload: async () => {}
  }
}

function register(modelId: string, sessionId: string = OWNER_SESSION_ID, onUnload?: () => void) {
  registerModel(
    modelId,
    {
      model: fakeModel(onUnload),
      path: '/models/model.gguf',
      config: {},
      modelType: ModelType.llamacppCompletion
    },
    sessionId
  )
}

test('leases: registerModel records the loading session', (t) => {
  const modelId = makeId('lease-register')
  register(modelId, 'A')
  t.alike(Array.from(getModelEntry(modelId)!.leases), ['A'])
  addModelLease(modelId, 'B')
  addModelLease(modelId, 'B')
  t.alike(Array.from(getModelEntry(modelId)!.leases).sort(), ['A', 'B'])
  t.alike(getModelIdsLeasedBy('B'), [modelId])
  t.is(releaseModelLease(modelId, 'C'), null, 'a session without a lease releases nothing')
  t.is(releaseModelLease(modelId, 'B'), 1)
  t.is(releaseModelLease(modelId, 'A'), 0)
  unregisterModel(modelId)
})

test('leases: unload from one session keeps the model for the other', async (t) => {
  const modelId = makeId('lease-shared')
  let unloaded = 0
  register(modelId, 'A', () => unloaded++)
  addModelLease(modelId, 'B')

  t.alike(await unloadModel({ modelId, sessionId: 'A' }), { released: true, unloaded: false })
  t.is(unloaded, 0)
  t.ok(getModelEntry(modelId), 'the model stays registered')

  t.alike(await unloadModel({ modelId, sessionId: 'C' }), { released: false, unloaded: false })
  t.is(unloaded, 0, 'a session without a lease cannot unload it')

  t.alike(await unloadModel({ modelId, sessionId: 'B' }), { released: true, unloaded: true })
  t.is(unloaded, 1)
  t.is(getModelEntry(modelId), null)
  await t.exception(
    unloadModel({ modelId, sessionId: 'B' }),
    ModelNotLoadedError as unknown as new () => Error
  )
})

test('leases: the unload handler reports leases and open sessions', async (t) => {
  clearSessions()
  const modelId = makeId('lease-handler')
  register(modelId, OWNER_SESSION_ID)
  addModelLease(modelId, 's-1')
  openSession('s-1')

  const first = await handleUnloadModel({ type: 'unloadModel', modelId, clearStorage: false })
  t.is(first.success, true)
  t.is(first.released, true)
  t.is(first.unloaded, false)
  t.is(first.hasActiveModels, true)
  t.is(first.hasOpenSessions, true)

  const second = await handleUnloadModel({
    type: 'unloadModel',
    modelId,
    clearStorage: false,
    sessionId: 's-1'
  })
  t.is(second.unloaded, true)
  t.is(second.hasActiveModels, false)
  t.is(second.hasOpenSessions, true, 'a session closing is not an unload')
  clearSessions()
})

test('leases: reloadConfig is refused while another session holds the model', async (t) => {
  clearSessions()
  const modelId = makeId('lease-reload')
    .slice(0, 16)
    .padEnd(16, '0')
    .replace(/[^0-9a-f]/g, '0')
  registerModel(
    modelId,
    {
      model: fakeModel(),
      path: '/models/whisper.bin',
      config: {},
      modelType: ModelType.whispercppTranscription
    },
    'A'
  )
  addModelLease(modelId, 'B')

  await t.exception(
    handleLoadModel({
      type: 'loadModel',
      modelId,
      modelType: ModelType.whispercppTranscription,
      modelConfig: {},
      sessionId: 'A'
    }),
    ModelLeasedError as unknown as new () => Error,
    'the refusal is a typed error, not a failed envelope'
  )

  releaseModelLease(modelId, 'B')
  const accepted = await handleLoadModel({
    type: 'loadModel',
    modelId,
    modelType: ModelType.whispercppTranscription,
    modelConfig: {},
    sessionId: 'A'
  })
  t.is(accepted.success, true, 'the sole holder may reconfigure')
  unregisterModel(modelId)
})

test('leases: closeSession cancels the session requests and releases its leases', async (t) => {
  clearSessions()
  const sessionId = makeId('session')
  handleOpenSession({ type: 'openSession', sessionId, name: 'closing' })

  const shared = makeId('lease-close-shared')
  const own = makeId('lease-close-own')
  let ownUnloaded = 0
  let sharedUnloaded = 0
  register(shared, OWNER_SESSION_ID, () => sharedUnloaded++)
  addModelLease(shared, sessionId)
  register(own, sessionId, () => ownUnloaded++)

  const registry = getRequestRegistry()
  const running = await registry.begin({
    requestId: 'r-close',
    sessionId,
    kind: 'completion',
    modelId: own
  })
  running.signal.addEventListener('abort', () => {
    void running[Symbol.asyncDispose]()
  })

  const response = await handleCloseSession({ type: 'closeSession', sessionId })
  t.is(response.success, true)
  t.is(response.cancelled, 1)
  t.alike(response.releasedModels?.sort(), [own, shared].sort())
  t.is(running.signal.aborted, true)
  t.is(ownUnloaded, 1, 'the model only this session held is unloaded')
  t.is(sharedUnloaded, 0, 'the shared model stays for the owner')
  t.alike(Array.from(getModelEntry(shared)!.leases), [OWNER_SESSION_ID])
  t.is(getModelEntry(own), null)

  await t.exception(handleCloseSession({ type: 'closeSession', sessionId }))
  unregisterModel(shared)
  clearSessions()
})
