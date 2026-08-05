import type { HarnessAgentRegistration } from '../agent-registration.ts'
import type { HarnessRuntimeInfo } from '../connect.ts'
import type {
  HarnessApprovalDecision,
  HarnessApprovalRequest
} from '../approval-port.ts'
import { createInMemoryHarnessRunStore } from '../in-memory-harness-run-store.ts'
import { createDurableHarnessRunStore } from '../durable-harness-run-store.ts'
import type { DurableStateInput } from '../durable-state-port.ts'
import type {
  HarnessRunRecord,
  HarnessRunStore,
  HarnessWorkChange,
  WatchHarnessWork
} from '../run-store.ts'
import type {
  HarnessAgentRunInput,
  HarnessAgentRunKey,
  HarnessEvent,
  HarnessLoggingConfig,
  HarnessSkillInfo
} from '../types.ts'
import { assertCompatibleHarness } from './compatibility.ts'
// Re-exported so the desktop surface is unchanged; it is defined in
// compatibility.ts so the React Native entry can reach it without this module.
export { HARNESS_HANDSHAKE } from './compatibility.ts'
import {
  launchDesktopHarness,
  type DesktopHarnessWorker
} from './desktop-launcher.ts'
import type { HarnessHostConfig, WireHostConfig } from './host-config.ts'
import { configForHarnessRuntime } from '../config.ts'

export interface CreateHarnessOptions {
  readonly inference?: 'deterministic' | 'qwen'
  readonly logging?: HarnessLoggingConfig
  readonly state?: DurableStateInput
  readonly host?: HarnessHostConfig
  /**
   * Worker entry sources. An application that supplies its own skills also
   * supplies the entries that statically import them.
   */
  readonly workers?: {
    readonly harnessChildEntry?: string
    readonly toolSandboxChildEntry?: string
  }
}

export interface HarnessRuntimeExit {
  readonly kind: 'closed' | 'crashed'
  readonly code: number | null
  readonly signal: string | null
}

export interface HarnessRuntime {
  readonly exited: Promise<HarnessRuntimeExit>
  readonly lifecycle: {
    suspend(): Promise<void>
    resume(): Promise<void>
  }
  readonly runtime: {
    describe(): Promise<HarnessRuntimeInfo>
  }
  ready(): Promise<void>
  listSkills(): Promise<readonly HarnessSkillInfo[]>
  registerAgent(registration: HarnessAgentRegistration): Promise<void>
  runAgent(input: HarnessAgentRunInput): AsyncIterable<HarnessEvent>
  cancelAgentRun(input: HarnessAgentRunKey): Promise<void>
  readRun(input: HarnessAgentRunKey): Promise<HarnessRunRecord | null>
  watchWork(input?: WatchHarnessWork): AsyncIterable<HarnessWorkChange>
  watchApprovals(): AsyncIterable<HarnessApprovalRequest>
  resolveApproval(decision: HarnessApprovalDecision): Promise<void>
  close(): Promise<void>
}

export function createHarness({
  inference = 'qwen',
  logging,
  state,
  host,
  workers
}: CreateHarnessOptions = {}): HarnessRuntime {
  const config = configForHarnessRuntime(logging)
  const runStore: HarnessRunStore = state
    ? createDurableHarnessRunStore(state)
    : createInMemoryHarnessRunStore()
  let worker: DesktopHarnessWorker | null = null
  let readyPromise: Promise<void> | null = null
  let closePromise: Promise<void> | null = null
  let terminalError: Error | null = null
  let resolveExit!: (exit: HarnessRuntimeExit) => void
  const exited = new Promise<HarnessRuntimeExit>((resolve) => {
    resolveExit = resolve
  })

  async function ready() {
    if (closePromise) throw new Error('Harness runtime is closed')
    if (terminalError) throw terminalError
    if (worker) return
    readyPromise ??= open()
    await readyPromise
    if (closePromise) throw new Error('Harness runtime is closed')
    if (terminalError) throw terminalError
  }

  async function open() {
    const next = await launchDesktopHarness({
      inference,
      config,
      runStore,
      ...(host ? { host } : {}),
      ...(workers ? { workers } : {})
    })
    try {
      const info = await next.client.describeRuntime()
      assertCompatibleHarness(info)
      if (closePromise) throw new Error('Harness runtime is closed')
      worker = next
      void next.client.exited.then(({ code, signal }) => {
        const deliberate = closePromise !== null
        if (!deliberate) {
          terminalError = new Error('Harness worker crashed')
          worker = null
        }
        resolveExit({
          kind: deliberate ? 'closed' : 'crashed',
          code,
          signal
        })
      })
    } catch (error) {
      await next.close().catch(() => {})
      throw error
    }
  }

  function requireClient() {
    if (closePromise) throw new Error('Harness runtime is closed')
    if (terminalError) throw terminalError
    if (!worker) throw new Error('Harness runtime is not ready')
    return worker.client
  }

  async function close() {
    closePromise ??= (async () => {
      if (readyPromise) await readyPromise.catch(() => {})
      const opened = worker
      worker = null
      if (opened) await opened.close()
      else await runStore.close()
    })()
    await closePromise
  }

  return {
    exited,
    ready,
    lifecycle: {
      async suspend() {
        await ready()
        await requireClient().suspend()
      },
      async resume() {
        await ready()
        await requireClient().resume()
      }
    },
    runtime: {
      async describe() {
        await ready()
        return requireClient().describeRuntime()
      }
    },
    async listSkills() {
      await ready()
      return requireClient().listSkills()
    },
    async registerAgent(registration) {
      await ready()
      await requireClient().registerAgent(registration)
    },
    async *runAgent(input) {
      await ready()
      yield* requireClient().runAgent(input)
    },
    async cancelAgentRun(input) {
      await ready()
      await requireClient().cancelAgentRun(input)
    },
    async readRun(input) {
      await ready()
      return requireClient().readRun(input)
    },
    async *watchWork(input) {
      await ready()
      yield* requireClient().watchWork(input)
    },
    async *watchApprovals() {
      await ready()
      yield* requireClient().watchApprovals()
    },
    async resolveApproval(decision) {
      await ready()
      await requireClient().resolveApproval(decision)
    },
    close
  }
}
