import fs from 'bare-fs'
import { getModel, type AnyModel } from '@/server/bare/registry/model-registry'
import type {
  FinetuneRunParams,
  FinetuneRunRequest,
  FinetuneProgress,
  FinetuneRequest,
  FinetuneResult,
  FinetuneStats,
  FinetuneStatus,
  FinetuneGetStateRequest
} from '@/schemas'
import { CompletionFailedError } from '@/utils/errors-server'
import { getRequestRegistry, withRequestContext } from '@/server/bare/runtime'
import { generateServerRequestId } from '@/server/bare/runtime/request-id'
import { getServerLogger } from '@/logging'

const PAUSE_CHECKPOINT_PREFIX = 'pause_checkpoint_step_'

type FinetuneOptions = FinetuneRunParams['options']

interface AddonFinetuneResult {
  op: 'finetune'
  status: 'COMPLETED' | 'PAUSED'
  stats?: FinetuneStats
}

interface AddonFinetuneHandle {
  on(event: 'stats', cb: (stats: FinetuneProgress) => void): AddonFinetuneHandle
  removeListener(event: 'stats', cb: (stats: FinetuneProgress) => void): AddonFinetuneHandle
  await(): Promise<AddonFinetuneResult>
}

interface FinetuneCapableModel extends AnyModel {
  finetune(options: FinetuneOptions): Promise<AddonFinetuneHandle>
  pause(): Promise<void>
  cancel(): Promise<void>
}

// Ref-count, not a Set: with an exclusive writer a second finetune queues behind
// the first, and both register before admission. A Set let the first's cleanup
// clear the key while the second was still training, so getFinetuneState()
// reported IDLE mid-run. Each call owns one ref and releases exactly one.
const finetuneRuntimeState = new Map<string, number>()

function getRunningFinetuneState(modelId: string) {
  return (finetuneRuntimeState.get(modelId) ?? 0) > 0
}

function registerRunningFinetune(modelId: string) {
  finetuneRuntimeState.set(modelId, (finetuneRuntimeState.get(modelId) ?? 0) + 1)
}

export function clearFinetuneRuntimeState(modelId: string) {
  const count = finetuneRuntimeState.get(modelId)
  if (count === undefined) return
  if (count <= 1) finetuneRuntimeState.delete(modelId)
  else finetuneRuntimeState.set(modelId, count - 1)
}

// modelIds whose single in-flight finetune currently HOLDS the exclusive lane
// (admitted, past the queued-abort check). One finetune per model (see the
// reject-second guard in startFinetune), so this is a plain membership set. Only an
// admitted finetune may be paused through the addon-global model.pause(); a finetune
// still queued behind a reader is cancelled instead, so pause never touches an
// unrelated reader.
const admittedFinetunes = new Set<string>()

// The single in-flight finetune's requestId per model. A QUEUED finetune is cancelled
// by this id, not by a broad cancel({ modelId, kind }): the registry's grant→register
// handoff leaves a brief window where the request is in neither the wait queue nor the
// active set — a broad cancel misses it, but cancel({ requestId }) covers it via the
// cancel-before-begin tripwire.
const finetuneRequestIds = new Map<string, string>()

// Models whose admitted finetune is mid-pause: model.pause() has been called but has
// not settled. A new finetune is rejected during this window even if the runtime ref
// has already cleared, because handle.await() can settle before model.pause() resolves.
const pausingModels = new Set<string>()

// Cancel the model's in-flight finetune by its tracked requestId (covers the
// registry grant→register handoff window via the cancel-before-begin tripwire),
// falling back to a broad cancel if the id is unknown.
function cancelTrackedFinetune(modelId: string): void {
  const requestId = finetuneRequestIds.get(modelId)
  if (requestId !== undefined) getRequestRegistry().cancel({ requestId })
  else getRequestRegistry().cancel({ modelId, kind: 'finetune' })
}

export function getFinetuneStateFromCheckpoints(options: FinetuneOptions): FinetuneStatus {
  const checkpointDirectory = options.checkpointSaveDir ?? './checkpoints'

  if (!fs.existsSync(checkpointDirectory)) {
    return 'IDLE'
  }

  try {
    const entries = fs.readdirSync(checkpointDirectory)

    for (const entry of entries) {
      if (typeof entry !== 'string') {
        continue
      }

      if (entry.startsWith(PAUSE_CHECKPOINT_PREFIX)) {
        return 'PAUSED'
      }
    }
  } catch (error) {
    throw new CompletionFailedError(
      `Failed to inspect finetune checkpoints in "${checkpointDirectory}"`,
      error
    )
  }

  return 'IDLE'
}

function validateExplicitFinetuneOperation(request: FinetuneRunRequest) {
  if (!request.operation) {
    return
  }

  const state = getFinetuneStateFromCheckpoints(request.options)

  if (request.operation === 'start' && state === 'PAUSED') {
    throw new CompletionFailedError(
      `Model "${request.modelId}" has a paused finetune checkpoint; resume it or cancel it before starting from scratch`
    )
  }

  if (request.operation === 'resume' && state === 'IDLE') {
    throw new CompletionFailedError(
      `Model "${request.modelId}" has no paused finetune checkpoint to resume`
    )
  }
}

export async function startFinetune(
  request: FinetuneRunRequest,
  onProgress?: (progress: FinetuneProgress) => void
): Promise<FinetuneResult> {
  const model = getModel(request.modelId) as FinetuneCapableModel
  validateExplicitFinetuneOperation(request)

  // One finetune per model: reject a second start/resume while one is pending or
  // running. With no queued finetune peers, pause/cancel never has to disambiguate
  // multiple finetunes, and a finetune that arrives mid-pause is simply rejected
  // because the pausing one still occupies the model until it unwinds.
  if (getRunningFinetuneState(request.modelId) || pausingModels.has(request.modelId)) {
    throw new CompletionFailedError(
      `Model "${request.modelId}" already has an active finetune; pause or cancel it before starting another`
    )
  }

  // Stable id, used for registry scoping and for targeted cancellation of this
  // finetune while it is queued (see pauseFinetune / cancelFinetune).
  const requestId = request.requestId ?? generateServerRequestId()

  // Take a ref before the async begin() so an immediate getFinetuneState() poll
  // observes RUNNING, not IDLE, and a concurrent start is rejected above. Released
  // on a failed begin() or on scope unwind below.
  registerRunningFinetune(request.modelId)
  finetuneRequestIds.set(request.modelId, requestId)

  // Scope the run into the registry so cancel({ requestId }) and
  // cancel({ modelId, kind: "finetune" }) reach it; onAbort forwards to
  // model.cancel().
  await using ctx = await getRequestRegistry()
    .begin({
      requestId,
      kind: 'finetune',
      modelId: request.modelId
    })
    .catch((err: unknown) => {
      clearFinetuneRuntimeState(request.modelId)
      if (finetuneRequestIds.get(request.modelId) === requestId) {
        finetuneRequestIds.delete(request.modelId)
      }
      throw err
    })
  const requestLogger = withRequestContext(getServerLogger(), ctx)
  // Cleared on scope unwind; deferred before the listener detach so LIFO
  // removes the listener first.
  ctx.scope.defer(() => {
    clearFinetuneRuntimeState(request.modelId)
    if (finetuneRequestIds.get(request.modelId) === requestId) {
      finetuneRequestIds.delete(request.modelId)
    }
  })

  // A finetune cancelled while queued resolves aborted without the exclusive
  // slot, so completions may still hold the lane. Stop before the global cancel
  // or any native finetune so neither runs against them.
  if (ctx.signal.aborted) {
    return { type: 'finetune', status: 'CANCELLED' }
  }

  // Past the queued-abort check: this finetune now holds the exclusive lane. Mark
  // it admitted so pauseFinetune pauses THIS finetune via model.pause() rather than
  // global-pausing (and killing a reader) while it is merely queued.
  admittedFinetunes.add(request.modelId)
  ctx.scope.defer(() => {
    admittedFinetunes.delete(request.modelId)
  })

  // The pre-admission validation above ran before this request queued for the
  // exclusive lane, so a peer finetune could have changed the checkpoint state
  // while we waited. Re-validate now that we hold the lane exclusively and the
  // state is stable.
  validateExplicitFinetuneOperation(request)

  // Global cancel is finetune's only stop; it runs exclusively, so nothing else
  // is on the model when this fires.
  const onAbort = () => {
    model.cancel().catch((err: unknown) => {
      requestLogger.warn(
        `[cancel] model.cancel() rejected during abort for modelId=${request.modelId}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener('abort', onAbort)
  })

  const handle = await model.finetune(request.options)

  if (onProgress) {
    handle.on('stats', onProgress)
    ctx.scope.defer(() => {
      handle.removeListener('stats', onProgress)
    })
  }

  const result = await handle.await()

  return {
    type: 'finetune',
    status: result.status,
    stats: result.stats
  }
}

export async function pauseFinetune(modelId: string): Promise<FinetuneResult> {
  // Validate the model is loaded on every path (matches main; getModel throws
  // ModelNotFoundError for an unknown/unloaded model) before reporting any state.
  const model = getModel(modelId) as FinetuneCapableModel

  if (admittedFinetunes.has(modelId)) {
    // The single finetune holds the model exclusively, so the addon-global pause is
    // safe (nothing else runs on the model). Bar a new finetune until the native
    // pause settles: the runtime ref can clear when handle.await() resolves, which
    // may precede model.pause()'s resolution.
    pausingModels.add(modelId)
    try {
      await model.pause()
    } finally {
      pausingModels.delete(modelId)
    }
    return { type: 'finetune', status: 'PAUSED' }
  }

  if (getRunningFinetuneState(modelId)) {
    // A finetune is pending but not yet admitted (queued behind a reader). A global
    // pause would cancel that unrelated reader, so cancel the queued finetune by its
    // own requestId. Nothing has trained, so report CANCELLED rather than a false
    // PAUSED.
    cancelTrackedFinetune(modelId)
    return { type: 'finetune', status: 'CANCELLED' }
  }

  // No finetune on this model: a no-op pause, but the model was validated above.
  return { type: 'finetune', status: 'PAUSED' }
}

// Routes cancellation through the registry; the model.cancel() forward is
// installed by startFinetune, so never call model.cancel() here.
export function cancelFinetune(modelId: string): Promise<FinetuneResult> {
  cancelTrackedFinetune(modelId)

  return Promise.resolve({
    type: 'finetune',
    status: 'CANCELLED'
  })
}

export function getFinetuneState(params: FinetuneGetStateRequest): FinetuneResult {
  const runtimeState = getRunningFinetuneState(params.modelId)

  return {
    type: 'finetune',
    status: runtimeState ? 'RUNNING' : getFinetuneStateFromCheckpoints(params.options)
  }
}

export async function finetune(
  request: FinetuneRequest,
  onProgress?: (progress: FinetuneProgress) => void
): Promise<FinetuneResult> {
  if (
    request.operation === undefined ||
    request.operation === 'start' ||
    request.operation === 'resume'
  ) {
    return startFinetune(request, onProgress)
  }

  switch (request.operation) {
    case 'getState':
      return getFinetuneState(request)
    case 'pause':
      return pauseFinetune(request.modelId)
    case 'cancel':
      return cancelFinetune(request.modelId)
  }
}
