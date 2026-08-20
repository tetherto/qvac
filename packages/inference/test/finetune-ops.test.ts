import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import test from 'brittle'
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/runtime/model-registry'
import {
  finetune as finetuneOp,
  getFinetuneState,
  getFinetuneStateFromCheckpoints,
  pauseFinetune,
  startFinetune
} from '@/plugins/builtin/llamacpp-completion/ops/finetune'
import { getRequestRegistry } from '@/runtime/index'
import { ModelType } from '@/schemas'
import { CompletionFailedError, ModelNotFoundError } from '@/errors'

function createTempCheckpointDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'finetune-op-test-'))
}

function createPauseCheckpointDir(baseDir: string, step: number) {
  const checkpointDir = path.join(baseDir, `pause_checkpoint_step_${String(step).padStart(8, '0')}`)
  fs.mkdirSync(checkpointDir, { recursive: true })
  return checkpointDir
}

function cleanupCheckpointDir(baseDir: string) {
  fs.rmSync(baseDir, { recursive: true, force: true })
}

test('startFinetune: propagates busy rejection from model.finetune()', async (t) => {
  clearRegistry()
  const modelId = 'finetune-busy-model'
  const busyError = new CompletionFailedError(
    `Model "${modelId}" already has an active job; pause or wait for it to finish before starting finetuning`
  )

  registerModel(modelId, {
    model: {
      finetune: async function () {
        throw busyError
      },
      pause: async function () {},
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/busy-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  let caughtError: unknown

  try {
    await startFinetune({
      type: 'finetune',
      modelId,
      operation: 'start',
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out'
      }
    })
  } catch (error) {
    caughtError = error
  } finally {
    unregisterModel(modelId)
    clearRegistry()
  }

  t.is(caughtError, busyError)
  t.ok(caughtError instanceof CompletionFailedError)
})

test('getFinetuneStateFromCheckpoints: reports paused when any pause checkpoint exists', async (t) => {
  const checkpointDir = createTempCheckpointDir()

  try {
    createPauseCheckpointDir(checkpointDir, 7)

    const state = await getFinetuneStateFromCheckpoints({
      trainDatasetDir: '/tmp/train.jsonl',
      validation: { type: 'none' },
      outputParametersDir: '/tmp/out',
      checkpointSaveDir: checkpointDir
    })

    t.is(state, 'PAUSED')
  } finally {
    cleanupCheckpointDir(checkpointDir)
  }
})

test('startFinetune: rejects explicit start when a pause checkpoint exists', async (t) => {
  clearRegistry()
  const modelId = 'finetune-start-paused-model'
  const checkpointDir = createTempCheckpointDir()
  let finetuneCalls = 0

  createPauseCheckpointDir(checkpointDir, 4)

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++
        throw new Error('finetune should not be called for explicit start')
      },
      pause: async function () {},
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/start-paused-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  let caughtError: unknown

  try {
    await startFinetune({
      type: 'finetune',
      modelId,
      operation: 'start',
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out',
        checkpointSaveDir: checkpointDir
      }
    })
  } catch (error) {
    caughtError = error
  } finally {
    unregisterModel(modelId)
    clearRegistry()
    cleanupCheckpointDir(checkpointDir)
  }

  t.is(finetuneCalls, 0)
  t.ok(caughtError instanceof CompletionFailedError)
})

test('startFinetune: rejects explicit resume when no pause checkpoint exists', async (t) => {
  clearRegistry()
  const modelId = 'finetune-resume-idle-model'
  const checkpointDir = createTempCheckpointDir()
  let finetuneCalls = 0

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++
        throw new Error('finetune should not be called for idle resume')
      },
      pause: async function () {},
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/resume-idle-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  let caughtError: unknown

  try {
    await startFinetune({
      type: 'finetune',
      modelId,
      operation: 'resume',
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out',
        checkpointSaveDir: checkpointDir
      }
    })
  } catch (error) {
    caughtError = error
  } finally {
    unregisterModel(modelId)
    clearRegistry()
    cleanupCheckpointDir(checkpointDir)
  }

  t.is(finetuneCalls, 0)
  t.ok(caughtError instanceof CompletionFailedError)
})

test('getFinetuneState: returns idle when no pause checkpoint exists', async (t) => {
  clearRegistry()
  const modelId = 'finetune-state-idle-model'
  const checkpointDir = createTempCheckpointDir()

  registerModel(modelId, {
    model: {
      finetune: async function () {
        throw new Error('finetune should not be called for getState')
      },
      pause: async function () {},
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/state-idle-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  try {
    const result = getFinetuneState({
      type: 'finetune',
      modelId,
      operation: 'getState',
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out',
        checkpointSaveDir: checkpointDir
      }
    })

    t.is(result.status, 'IDLE')
  } finally {
    unregisterModel(modelId)
    clearRegistry()
    cleanupCheckpointDir(checkpointDir)
  }
})

test('getFinetuneState: returns running while finetune is active', async (t) => {
  clearRegistry()
  const modelId = 'finetune-state-running-model'
  const checkpointDir = createTempCheckpointDir()
  let resolveAwait:
    | ((value: {
        op: 'finetune'
        status: 'COMPLETED'
        stats: {
          global_steps: number
          epochs_completed: number
        }
      }) => void)
    | null = null

  registerModel(modelId, {
    model: {
      finetune: async function () {
        return {
          on() {
            return this
          },
          removeListener() {
            return this
          },
          await() {
            return new Promise((resolve) => {
              resolveAwait = resolve
            })
          }
        }
      },
      pause: async function () {},
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/state-running-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  try {
    const startPromise = startFinetune({
      type: 'finetune',
      modelId,
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out',
        checkpointSaveDir: checkpointDir
      }
    })

    const result = getFinetuneState({
      type: 'finetune',
      modelId,
      operation: 'getState',
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out',
        checkpointSaveDir: checkpointDir
      }
    })

    t.is(result.status, 'RUNNING')

    // Yield to let startFinetune reach model.finetune().await() and set resolveAwait.
    await new Promise<void>((r) => setTimeout(r, 0))
    resolveAwait!({
      op: 'finetune',
      status: 'COMPLETED',
      stats: {
        global_steps: 1,
        epochs_completed: 1
      }
    })

    await startPromise
  } finally {
    unregisterModel(modelId)
    clearRegistry()
    cleanupCheckpointDir(checkpointDir)
  }
})

test('finetune: omitted operation preserves automatic addon behavior', async (t) => {
  clearRegistry()
  const modelId = 'finetune-auto-model'
  const checkpointDir = createTempCheckpointDir()
  let finetuneCalls = 0
  let receivedCheckpointDir: string | undefined

  createPauseCheckpointDir(checkpointDir, 9)

  registerModel(modelId, {
    model: {
      finetune: async function (options: { checkpointSaveDir?: string }) {
        finetuneCalls++
        receivedCheckpointDir = options.checkpointSaveDir

        return {
          on() {
            return this
          },
          removeListener() {
            return this
          },
          async await() {
            return {
              op: 'finetune' as const,
              status: 'COMPLETED' as const,
              stats: {
                global_steps: 9,
                epochs_completed: 1
              }
            }
          }
        }
      },
      pause: async function () {},
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/auto-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  try {
    const result = await finetuneOp({
      type: 'finetune',
      modelId,
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out',
        checkpointSaveDir: checkpointDir
      }
    })

    t.is(result.status, 'COMPLETED')
    t.is(finetuneCalls, 1)
    t.is(receivedCheckpointDir, checkpointDir)
  } finally {
    unregisterModel(modelId)
    clearRegistry()
    cleanupCheckpointDir(checkpointDir)
  }
})

test('startFinetune: detaches progress listeners after completion', async (t) => {
  clearRegistry()
  const modelId = 'finetune-listener-model'
  const seenSteps: number[] = []
  const progress = {
    is_train: true,
    loss: 0.9,
    loss_uncertainty: null,
    accuracy: 0.8,
    accuracy_uncertainty: null,
    global_steps: 2,
    current_epoch: 0,
    current_batch: 2,
    total_batches: 4,
    elapsed_ms: 800,
    eta_ms: 1200
  }

  type ProgressListener = (value: typeof progress) => void
  let registeredListener: ProgressListener | null = null
  let removeListenerCalls = 0
  const handle = {
    on(event: 'stats', cb: ProgressListener) {
      t.is(event, 'stats')
      registeredListener = cb
      return handle
    },
    removeListener(event: 'stats', cb: ProgressListener) {
      t.is(event, 'stats')
      t.is(cb, registeredListener)
      removeListenerCalls++
      return handle
    },
    async await() {
      registeredListener?.(progress)
      return {
        op: 'finetune' as const,
        status: 'COMPLETED' as const,
        stats: {
          global_steps: 2,
          epochs_completed: 1
        }
      }
    }
  }

  registerModel(modelId, {
    model: {
      finetune: async function () {
        return handle
      },
      pause: async function () {},
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/listener-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  try {
    const result = await startFinetune(
      {
        type: 'finetune',
        modelId,
        operation: 'start',
        options: {
          trainDatasetDir: '/tmp/train.jsonl',
          validation: { type: 'none' },
          outputParametersDir: '/tmp/out'
        }
      },
      (update) => {
        seenSteps.push(update.global_steps)
      }
    )

    t.alike(seenSteps, [2])
    t.is(result.status, 'COMPLETED')
    t.is(removeListenerCalls, 1)
  } finally {
    unregisterModel(modelId)
    clearRegistry()
  }
})

test('pauseFinetune: a finetune queued behind an active reader is not global-paused and does not later start', async (t) => {
  clearRegistry()
  const modelId = 'finetune-pause-queued-model'
  let pauseCalls = 0
  let finetuneCalls = 0

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++
        return {
          on: () => {},
          removeListener: () => {},
          await: async () => ({ status: 'COMPLETED', stats: {} })
        }
      },
      pause: async function () {
        pauseCalls++
      },
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/pause-queued-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  // A completion "reader" holds the shared per-model lane; the exclusive finetune
  // must queue behind it (never admitted).
  const reader = await getRequestRegistry().begin({
    requestId: 'reader-1',
    kind: 'completion',
    modelId
  })

  try {
    const ftPromise = startFinetune({
      type: 'finetune',
      modelId,
      operation: 'start',
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out'
      }
    })
    // Let the finetune reach the exclusive-lane wait behind the reader.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    // Pause while the finetune is only queued: it must NOT invoke the addon-global
    // pause (which cancels the active reader), and the finetune must not start once
    // the reader releases.
    const pauseResult = await pauseFinetune(modelId)
    t.is(
      pauseResult.status,
      'CANCELLED',
      'queued-only pause reports cancellation because no resumable checkpoint exists'
    )
    t.is(
      pauseCalls,
      0,
      'no addon-global pause while the finetune is only queued (would kill the reader)'
    )

    // Release the reader; the queued-then-paused finetune must not start.
    await reader[Symbol.asyncDispose]()
    const ftResult = await ftPromise
    t.is(ftResult.status, 'CANCELLED', 'queued finetune does not start after a pause')
    t.is(finetuneCalls, 0, 'model.finetune() never ran for the queued-then-paused finetune')
  } finally {
    unregisterModel(modelId)
    clearRegistry()
  }
})

test('pauseFinetune: with no finetune running never invokes the addon-global pause', async (t) => {
  clearRegistry()
  const modelId = 'finetune-pause-none-model'
  let pauseCalls = 0

  registerModel(modelId, {
    model: {
      finetune: async function () {
        throw new Error('finetune should not run')
      },
      pause: async function () {
        pauseCalls++
      },
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/pause-none-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  try {
    const result = await pauseFinetune(modelId)
    t.is(result.status, 'PAUSED')
    t.is(pauseCalls, 0, 'no addon-global pause when no finetune is running')
  } finally {
    unregisterModel(modelId)
    clearRegistry()
  }
})

test('pauseFinetune: an admitted finetune is paused through model.pause()', async (t) => {
  clearRegistry()
  const modelId = 'finetune-pause-admitted-model'
  let pauseCalls = 0
  let finetuneCalls = 0
  let resolveAwait: ((value: { status: string; stats: object }) => void) | null = null

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++
        return {
          on: () => {},
          removeListener: () => {},
          await: () =>
            new Promise((resolve) => {
              resolveAwait = resolve
            })
        }
      },
      pause: async function () {
        pauseCalls++
        resolveAwait?.({ status: 'PAUSED', stats: {} })
      },
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/pause-admitted-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  try {
    const startPromise = startFinetune({
      type: 'finetune',
      modelId,
      operation: 'start',
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'none' },
        outputParametersDir: '/tmp/out'
      }
    })
    await new Promise<void>((r) => setTimeout(r, 20))

    const pauseResult = await pauseFinetune(modelId)
    t.is(pauseResult.status, 'PAUSED')
    t.is(pauseCalls, 1, 'admitted finetune is paused via model.pause()')

    const startResult = await startPromise
    t.is(startResult.status, 'PAUSED')
    t.is(finetuneCalls, 1)
  } finally {
    unregisterModel(modelId)
    clearRegistry()
  }
})

test('startFinetune: rejects a second finetune while one is already running', async (t) => {
  clearRegistry()
  const modelId = 'finetune-reject-second-model'
  let finetuneCalls = 0
  let resolveAwait: (value: { status: string; stats: object }) => void = () => {}

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++
        return {
          on: () => {},
          removeListener: () => {},
          await: () =>
            new Promise<{ status: string; stats: object }>((resolve) => {
              resolveAwait = resolve
            })
        }
      },
      pause: async function () {},
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/reject-second-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  const options = {
    trainDatasetDir: '/tmp/train.jsonl',
    validation: { type: 'none' as const },
    outputParametersDir: '/tmp/out'
  }

  try {
    const activePromise = startFinetune({ type: 'finetune', modelId, operation: 'start', options })
    await new Promise<void>((r) => setTimeout(r, 20))

    let secondError: unknown
    try {
      await startFinetune({ type: 'finetune', modelId, operation: 'start', options })
    } catch (error) {
      secondError = error
    }
    t.ok(
      secondError instanceof CompletionFailedError,
      'a second finetune while one is active is rejected'
    )
    t.is(finetuneCalls, 1, 'the second finetune never reached the addon')

    // Let the first finish so the model frees.
    resolveAwait({ status: 'COMPLETED', stats: {} })
    t.is((await activePromise).status, 'COMPLETED')
  } finally {
    unregisterModel(modelId)
    clearRegistry()
  }
})

test('startFinetune: rejects a second finetune while the first is pausing', async (t) => {
  clearRegistry()
  const modelId = 'finetune-reject-during-pause-model'
  let finetuneCalls = 0
  let resolveActiveAwait: ((value: { status: string; stats: object }) => void) | null = null
  let releaseNativePause = () => {}
  let markPauseEntered = () => {}
  const pauseEntered = new Promise<void>((resolve) => {
    markPauseEntered = resolve
  })

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++
        return {
          on: () => {},
          removeListener: () => {},
          await: () =>
            new Promise((resolve) => {
              resolveActiveAwait = resolve
            })
        }
      },
      pause: async function () {
        // Adversarial ordering: the admitted finetune's handle settles BEFORE the
        // native pause resolves. This clears the runtime ref while pause is still in
        // flight, so the pausing barrier (not the ref) must reject a new finetune.
        markPauseEntered()
        resolveActiveAwait?.({ status: 'PAUSED', stats: {} })
        await new Promise<void>((resolve) => {
          releaseNativePause = resolve
        })
      },
      cancel: async function () {}
    } as unknown as AnyModel,
    path: '/tmp/reject-during-pause-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  const options = {
    trainDatasetDir: '/tmp/train.jsonl',
    validation: { type: 'none' as const },
    outputParametersDir: '/tmp/out'
  }

  try {
    const activePromise = startFinetune({ type: 'finetune', modelId, operation: 'start', options })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    const pausePromise = pauseFinetune(modelId)
    await pauseEntered
    // The admitted finetune has already unwound (its runtime ref is cleared), but the
    // native pause has not settled — the barrier must still reject a new finetune.
    t.is((await activePromise).status, 'PAUSED')

    let secondError: unknown
    try {
      await startFinetune({ type: 'finetune', modelId, operation: 'start', options })
    } catch (error) {
      secondError = error
    }
    t.ok(
      secondError instanceof CompletionFailedError,
      'a second finetune during pause is rejected by the barrier even after the handle settled'
    )
    t.is(finetuneCalls, 1, 'the second finetune never reached the addon')

    releaseNativePause()
    t.is((await pausePromise).status, 'PAUSED')
  } finally {
    releaseNativePause()
    unregisterModel(modelId)
    clearRegistry()
  }
})

test('pauseFinetune: an unloaded model still raises ModelNotFoundError', async (t) => {
  clearRegistry()
  const modelId = 'finetune-pause-unloaded-model'
  unregisterModel(modelId)

  let caughtError: unknown
  try {
    await pauseFinetune(modelId)
  } catch (error) {
    caughtError = error
  }

  t.ok(caughtError instanceof ModelNotFoundError)
})

test('startFinetune: revalidates checkpoint state after the exclusive-lane wait', async (t) => {
  clearRegistry()
  const checkpointDir = createTempCheckpointDir()
  const modelId = 'finetune-revalidate-model'
  const options = {
    trainDatasetDir: '/tmp/train.jsonl',
    validation: { type: 'none' as const },
    outputParametersDir: '/tmp/out',
    checkpointSaveDir: checkpointDir
  }
  let finetuneCalls = 0

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++
        return {
          on: () => {},
          removeListener: () => {},
          await: async () => ({ status: 'COMPLETED', stats: {} })
        }
      },
      pause: async () => {},
      cancel: async () => {}
    } as unknown as AnyModel,
    path: '/tmp/revalidate-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  // A completion reader holds the shared lane; the exclusive finetune queues behind
  // it (a valid 'start' at its pre-admission check — checkpoint dir empty ⇒ IDLE).
  const reader = await getRequestRegistry().begin({
    requestId: 'reader-1',
    kind: 'completion',
    modelId
  })

  try {
    const ftPromise = startFinetune({ type: 'finetune', modelId, operation: 'start', options })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    // A peer pauses the model while the finetune waits — the state it validated
    // against is now stale: a paused checkpoint appears, so 'start' is disallowed.
    createPauseCheckpointDir(checkpointDir, 5)

    // Release the reader; the finetune is admitted and must re-validate before
    // model.finetune() runs.
    await reader[Symbol.asyncDispose]()

    let ftError: unknown = null
    try {
      await ftPromise
    } catch (error) {
      ftError = error
    }
    t.ok(
      ftError instanceof CompletionFailedError,
      'finetune rejects on re-validation because the checkpoint state changed while it queued'
    )
    t.is(finetuneCalls, 0, 'model.finetune never ran; the finetune was rejected before native work')
  } finally {
    unregisterModel(modelId)
    clearRegistry()
    cleanupCheckpointDir(checkpointDir)
  }
})
