interface CancelableRun {
  cancel(reason?: string): Promise<void>
}

const DEFAULT_CLOSE_TIMEOUT_MS = 10_000
const MAX_CLOSE_TIMEOUT_MS = 60_000

export interface HarnessRunKey {
  readonly agentId: string
  readonly runId: string
}

export interface HarnessRunRegistry {
  add(key: HarnessRunKey, run: CancelableRun): void
  remove(key: HarnessRunKey, run: CancelableRun): void
  cancel(key: HarnessRunKey, reason?: string): Promise<void>
  close(): Promise<void>
}

export interface CreateRunRegistryOptions {
  readonly closeTimeoutMs?: number
}

export function createRunRegistry({
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS
}: CreateRunRegistryOptions = {}): HarnessRunRegistry {
  validateCloseTimeout(closeTimeoutMs)
  const live = new Map<string, Map<string, CancelableRun>>()
  let liveCount = 0
  let closed = false
  let resolveDrained: (() => void) | undefined
  let closing: Promise<void> | undefined

  return {
    add(key, run) {
      if (closed) throw new Error('run registry is closed')
      const agentRuns = live.get(key.agentId) ?? new Map<string, CancelableRun>()
      if (agentRuns.has(key.runId)) throw new Error(alreadyLiveMessage(key))
      agentRuns.set(key.runId, run)
      live.set(key.agentId, agentRuns)
      liveCount++
    },
    remove(key, run) {
      const agentRuns = live.get(key.agentId)
      if (agentRuns?.get(key.runId) !== run) return
      agentRuns.delete(key.runId)
      if (agentRuns.size === 0) live.delete(key.agentId)
      liveCount--
      if (closed && liveCount === 0) resolveDrained?.()
    },
    async cancel(key, reason) {
      const run = live.get(key.agentId)?.get(key.runId)
      if (!run) throw new Error(notLiveMessage(key))
      await run.cancel(reason)
    },
    close() {
      closing ??= withTimeout((async () => {
        closed = true
        const runs = [...live.values()].flatMap((agentRuns) => [...agentRuns.values()])
        await Promise.all(runs.map((run) => run.cancel('harness closed')))
        if (liveCount === 0) return
        await new Promise<void>((resolve) => {
          resolveDrained = resolve
        })
      })(), closeTimeoutMs)
      return closing
    }
  }
}

function withTimeout(operation: Promise<void>, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `run registry timed out after ${timeoutMs}ms waiting for runs to drain`
        )
      )
    }, timeoutMs)
    operation.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function validateCloseTimeout(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CLOSE_TIMEOUT_MS
  ) {
    throw new Error(
      `run registry close timeout must be an integer from 1 through ${MAX_CLOSE_TIMEOUT_MS}`
    )
  }
}

function alreadyLiveMessage({ agentId, runId }: HarnessRunKey) {
  return `agent run is already live: agentId="${agentId}", runId="${runId}"`
}

function notLiveMessage({ agentId, runId }: HarnessRunKey) {
  return `agent run is not live: agentId="${agentId}", runId="${runId}"`
}
