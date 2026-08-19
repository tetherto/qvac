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

// Per-model finetune request tracking for pause targeting. `ids` holds every
// in-flight finetune requestId for the model; `admitted` is the one that currently
// HOLDS the exclusive lane (at most one, since finetune is exclusive) — the rest are
// queued peers. Only the admitted finetune may be paused through the addon-global
// model.pause(); queued finetunes (peers or ones waiting behind a reader) must be
// cancelled by requestId instead, so pause never touches an unrelated reader and no
// queued finetune slips into the lane the pause frees.
interface FinetuneTracking {
  ids: Set<string>
  admitted: string | null
}
const finetuneTracking = new Map<string, FinetuneTracking>()

function trackFinetune(modelId: string, requestId: string) {
  const existing = finetuneTracking.get(modelId)
  if (existing) existing.ids.add(requestId)
  else finetuneTracking.set(modelId, { ids: new Set([requestId]), admitted: null })
}

function markFinetuneAdmitted(modelId: string, requestId: string) {
  const tracking = finetuneTracking.get(modelId)
  if (tracking) tracking.admitted = requestId
}

function untrackFinetune(modelId: string, requestId: string) {
  const tracking = finetuneTracking.get(modelId)
  if (!tracking) return
  tracking.ids.delete(requestId)
  if (tracking.admitted === requestId) tracking.admitted = null
  if (tracking.ids.size === 0) finetuneTracking.delete(modelId)
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

  // Take a ref before the async begin() so an immediate getFinetuneState() poll
  // observes RUNNING, not IDLE. This call owns exactly one ref and releases it
  // on a failed begin() or on scope unwind below.
  registerRunningFinetune(request.modelId)

  // Stable id, used for both registry scoping and pause targeting (below).
  const requestId = request.requestId ?? generateServerRequestId()
  trackFinetune(request.modelId, requestId)

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
      untrackFinetune(request.modelId, requestId)
      throw err
    })
  const requestLogger = withRequestContext(getServerLogger(), ctx)
  // Cleared on scope unwind; deferred before the listener detach so LIFO
  // removes the listener first.
  ctx.scope.defer(() => {
    clearFinetuneRuntimeState(request.modelId)
    untrackFinetune(request.modelId, requestId)
  })

  // A finetune cancelled while queued resolves aborted without the exclusive
  // slot, so completions may still hold the lane. Stop before the global cancel
  // or any native finetune so neither runs against them.
  if (ctx.signal.aborted) {
    return { type: 'finetune', status: 'CANCELLED' }
  }

  // Past the queued-abort check: this finetune now holds the exclusive lane. Mark
  // it admitted so pauseFinetune pauses THIS finetune (and cancels any queued
  // peers) rather than global-pausing while it is merely queued.
  markFinetuneAdmitted(request.modelId, requestId)

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
  const tracking = finetuneTracking.get(modelId)

  if (tracking && tracking.admitted !== null) {
    // An admitted finetune holds the model exclusively, so the addon-global pause is
    // safe. Cancel every QUEUED finetune peer FIRST so none slips into the lane the
    // pause is about to free, then pause the admitted one.
    const admittedId = tracking.admitted
    for (const id of tracking.ids) {
      if (id !== admittedId) getRequestRegistry().cancel({ requestId: id })
    }
    const model = getModel(modelId)
    await model.pause()
    return { type: 'finetune', status: 'PAUSED' }
  }

  // No admitted finetune: a global pause would cancel an unrelated active reader
  // (completion / LLM-translate). Cancel any queued finetune instead (nothing has
  // trained yet) and never touch the addon globally.
  getRequestRegistry().cancel({ modelId, kind: 'finetune' })
  return { type: 'finetune', status: 'PAUSED' }
}

// Routes cancellation through the registry; the model.cancel() forward is
// installed by startFinetune, so never call model.cancel() here.
export function cancelFinetune(modelId: string): Promise<FinetuneResult> {
  // cancel() is synchronous; Promise.resolve keeps the Promise<FinetuneResult>
  // return shape.
  getRequestRegistry().cancel({ modelId, kind: 'finetune' })

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
