import type {
  LaunchedToolSandbox,
  ToolSandboxCancelRequest,
  ToolSandboxDescription,
  ToolSandboxInvokeRequest,
  ToolSandboxLauncher,
  ToolSandboxProcessExit,
  ToolSandboxResult
} from './types.ts'

const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const MAX_IDLE_TIMEOUT_MS = 15 * 60_000

export interface ToolSandboxRegistryExit extends ToolSandboxProcessExit {
  readonly agentId: string
  readonly generation: number
  readonly expected: boolean
  readonly exitError?: Error
  readonly cleanupError?: Error
}

export interface ToolSandboxRegistry {
  ready(agentId: string): Promise<ToolSandboxDescription>
  invoke(
    input: Omit<ToolSandboxInvokeRequest, 'generation'> & {
      readonly agentId: string
    }
  ): Promise<ToolSandboxResult>
  cancel(input: {
    readonly agentId: string
    readonly invocationId: string
  }): Promise<void>
  close(): Promise<void>
}

export interface CreateToolSandboxRegistryOptions {
  readonly launcher: ToolSandboxLauncher
  readonly idleTimeoutMs?: number
  readonly onStart?: (start: {
    readonly agentId: string
    readonly generation: number
    readonly processId: number
  }) => void
  readonly onExit?: (exit: ToolSandboxRegistryExit) => void
}

interface SandboxSlot {
  readonly launched: LaunchedToolSandbox
  description?: Promise<ToolSandboxDescription>
  exited: boolean
  expectedClose: boolean
  activeInvocations: number
  idleTimer?: ReturnType<typeof setTimeout>
}

interface CleanupRetry {
  readonly agentId: string
  readonly generation: number
  readonly cleanup: () => Promise<void>
}

interface InvocationRoute {
  readonly slot: SandboxSlot
  readonly request: ToolSandboxCancelRequest
}

export function createToolSandboxRegistry({
  launcher,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onStart,
  onExit
}: CreateToolSandboxRegistryOptions): ToolSandboxRegistry {
  validateIdleTimeout(idleTimeoutMs)
  const slots = new Map<string, SandboxSlot>()
  const openings = new Map<string, Promise<SandboxSlot>>()
  const generations = new Map<string, number>()
  const invocations = new Map<string, InvocationRoute>()
  const cleanupRetries = new Map<string, CleanupRetry>()
  const retirements = new Set<Promise<void>>()
  const lifecycleErrors: Error[] = []
  let closed = false

  async function ensure(agentId: string) {
    if (closed) throw new Error('tool sandbox registry is closed')
    const current = slots.get(agentId)
    if (current && !current.exited) return ensureReady(agentId, current)
    const opening = openings.get(agentId)
    if (opening) return opening.then((slot) => ensureReady(agentId, slot))
    await retryAgentCleanups(agentId)

    const generation = (generations.get(agentId) ?? 0) + 1
    generations.set(agentId, generation)
    const pending = launcher
      .launch({ agentId, generation })
      .then(async (launched) => {
        if (
          launched.agentId !== agentId ||
          launched.generation !== generation
        ) {
          await launched.sandbox.close()
          throw new Error('tool sandbox launcher returned mismatched identity')
        }
        if (closed) {
          return closeLaunchAfterRegistryClosure(launched)
        }
        const slot: SandboxSlot = {
          launched,
          exited: false,
          expectedClose: false,
          activeInvocations: 0
        }
        slots.set(agentId, slot)
        observeExit(agentId, slot)
        return slot
      })
      .finally(() => {
        if (openings.get(agentId) === pending) openings.delete(agentId)
      })
    openings.set(agentId, pending)
    return pending.then((slot) => ensureReady(agentId, slot))
  }

  async function ensureReady(agentId: string, slot: SandboxSlot) {
    slot.description ??= slot.launched.sandbox.ready().then((description) => {
      assertCurrent(agentId, slot, description.generation)
      try {
        onStart?.({
          agentId,
          generation: description.generation,
          processId: description.processId
        })
      } catch (error) {
        lifecycleErrors.push(toError(error))
      }
      return description
    })
    await slot.description
    scheduleIdle(agentId, slot)
    return slot
  }

  function observeExit(agentId: string, slot: SandboxSlot) {
    const observation = slot.launched.exited.then(
      (exit) => finishExit(agentId, slot, exit),
      (error) =>
        finishExit(
          agentId,
          slot,
          { code: null, signal: null },
          toError(error)
        )
    )
    void observation.catch((error) => {
      lifecycleErrors.push(toError(error))
    })
  }

  async function finishExit(
    agentId: string,
    slot: SandboxSlot,
    exit: ToolSandboxProcessExit,
    exitError?: Error
  ) {
    slot.exited = true
    clearIdle(slot)
    if (slots.get(agentId) === slot) slots.delete(agentId)
    const cleanupError = await attemptCleanup(slot.launched)
    try {
      onExit?.({
        agentId,
        generation: slot.launched.generation,
        code: exit.code,
        signal: exit.signal,
        expected: slot.expectedClose,
        ...(exitError ? { exitError } : {}),
        ...(cleanupError ? { cleanupError } : {})
      })
    } catch (error) {
      lifecycleErrors.push(toError(error))
    }
  }

  function scheduleIdle(agentId: string, slot: SandboxSlot) {
    clearIdle(slot)
    if (
      closed ||
      slot.exited ||
      slot.activeInvocations > 0 ||
      slots.get(agentId) !== slot
    ) {
      return
    }
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined
      if (
        closed ||
        slot.exited ||
        slot.activeInvocations > 0 ||
        slots.get(agentId) !== slot
      ) {
        return
      }
      slot.expectedClose = true
      slots.delete(agentId)
      const retirement = slot.launched.sandbox.close().catch((error) => {
        lifecycleErrors.push(toError(error))
      }).finally(() => {
        retirements.delete(retirement)
      })
      retirements.add(retirement)
    }, idleTimeoutMs)
  }

  function clearIdle(slot: SandboxSlot) {
    if (slot.idleTimer === undefined) return
    clearTimeout(slot.idleTimer)
    slot.idleTimer = undefined
  }

  async function attemptCleanup(launched: LaunchedToolSandbox) {
    const key = cleanupKey(launched.agentId, launched.generation)
    try {
      await launched.cleanup()
      cleanupRetries.delete(key)
      return undefined
    } catch (error) {
      const cleanupError = toError(error)
      cleanupRetries.set(key, {
        agentId: launched.agentId,
        generation: launched.generation,
        cleanup: launched.cleanup
      })
      return cleanupError
    }
  }

  async function retryAgentCleanups(agentId: string) {
    const retries = [...cleanupRetries.values()].filter(
      (retry) => retry.agentId === agentId
    )
    await retryCleanups(retries)
  }

  async function retryCleanups(retries: readonly CleanupRetry[]) {
    const results = await Promise.allSettled(
      retries.map(async (retry) => {
        await retry.cleanup()
        cleanupRetries.delete(
          cleanupKey(retry.agentId, retry.generation)
        )
      })
    )
    const errors: Error[] = []
    collectRejected(results, errors)
    return errors
  }

  async function closeLaunchAfterRegistryClosure(
    launched: LaunchedToolSandbox
  ): Promise<never> {
    void launched.exited.catch((error) => {
      lifecycleErrors.push(toError(error))
    })
    const closeResult = await Promise.allSettled([
      launched.sandbox.close()
    ])
    collectRejected(closeResult, lifecycleErrors)
    await attemptCleanup(launched)
    throw new RegistryClosedDuringLaunchError()
  }

  return {
    async ready(agentId) {
      const slot = await ensure(agentId)
      const description = await slot.description
      if (!description) {
        throw new Error('tool sandbox description is unavailable')
      }
      assertCurrent(agentId, slot, description.generation)
      return description
    },
    async invoke(input) {
      const slot = await ensure(input.agentId)
      clearIdle(slot)
      slot.activeInvocations++
      const request = {
        invocationId: input.invocationId,
        generation: slot.launched.generation,
        toolName: input.toolName,
        input: input.input
      }
      const key = invocationKey(input.agentId, input.invocationId)
      const route = {
        slot,
        request: {
          invocationId: request.invocationId,
          generation: request.generation
        }
      }
      invocations.set(key, route)
      try {
        const result = await slot.launched.sandbox.invoke(request)
        assertCurrent(input.agentId, slot, result.generation)
        if (
          result.invocationId !== request.invocationId ||
          result.generation !== request.generation
        ) {
          throw new Error('tool sandbox returned a mismatched invocation result')
        }
        return result
      } finally {
        if (invocations.get(key) === route) invocations.delete(key)
        slot.activeInvocations--
        scheduleIdle(input.agentId, slot)
      }
    },
    async cancel(input) {
      const route = invocations.get(
        invocationKey(input.agentId, input.invocationId)
      )
      if (!route || route.slot.exited) return
      await route.slot.launched.sandbox.cancel(route.request)
    },
    async close() {
      if (closed) {
        const retryErrors = await retryCleanups([...cleanupRetries.values()])
        throwCollected(retryErrors, 'tool sandbox cleanup retry failed')
        return
      }
      closed = true
      const errors: Error[] = []
      try {
        collectOpeningRejected(
          await Promise.allSettled([...openings.values()]),
          errors
        )
        collectRejected(
          await Promise.allSettled([...retirements]),
          errors
        )
        const live = [...slots.values()]
        for (const slot of live) {
          clearIdle(slot)
          slot.expectedClose = true
        }
        collectRejected(
          await Promise.allSettled(
            live.map((slot) => slot.launched.sandbox.close())
          ),
          errors
        )
        await Promise.all(
          live.map((slot) => attemptCleanup(slot.launched))
        )
        errors.push(
          ...(await retryCleanups([...cleanupRetries.values()]))
        )
        errors.push(...lifecycleErrors)
      } finally {
        slots.clear()
        openings.clear()
        invocations.clear()
        generations.clear()
        retirements.clear()
        lifecycleErrors.length = 0
      }
      throwCollected(errors, 'tool sandbox registry close failed')
    }
  }

  function assertCurrent(
    agentId: string,
    slot: SandboxSlot,
    generation: number
  ) {
    if (
      slot.exited ||
      slots.get(agentId) !== slot ||
      generation !== slot.launched.generation
    ) {
      throw new Error(
        `stale sandbox result for ${agentId} generation ${generation}`
      )
    }
  }
}

function validateIdleTimeout(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_IDLE_TIMEOUT_MS
  ) {
    throw new Error(
      `sandbox idle timeout must be an integer from 1 through ${MAX_IDLE_TIMEOUT_MS}`
    )
  }
}

function invocationKey(agentId: string, invocationId: string) {
  return `${agentId}\0${invocationId}`
}

function cleanupKey(agentId: string, generation: number) {
  return `${agentId}\0${generation}`
}

function collectRejected<T>(
  results: readonly PromiseSettledResult<T>[],
  errors: Error[]
) {
  for (const result of results) {
    if (result.status === 'rejected') errors.push(toError(result.reason))
  }
}

function collectOpeningRejected<T>(
  results: readonly PromiseSettledResult<T>[],
  errors: Error[]
) {
  for (const result of results) {
    if (
      result.status === 'rejected' &&
      !(result.reason instanceof RegistryClosedDuringLaunchError)
    ) {
      errors.push(toError(result.reason))
    }
  }
}

function throwCollected(errors: readonly Error[], message: string) {
  if (errors.length === 0) return
  throw new AggregateError(errors, message)
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

class RegistryClosedDuringLaunchError extends Error {
  constructor() {
    super('tool sandbox registry is closed')
    this.name = 'RegistryClosedDuringLaunchError'
  }
}
