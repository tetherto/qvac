import type {
  LaunchedToolSandbox,
  ToolSandboxInvokeRequest,
  ToolSandboxLauncher,
  ToolSandboxProcessExit,
  ToolSandboxResult
} from './types.ts'

export interface FakeToolSandboxInvocation extends ToolSandboxInvokeRequest {
  readonly agentId: string
}

export interface FakeToolSandboxLauncher {
  readonly launches: ReadonlyArray<{
    readonly agentId: string
    readonly generation: number
  }>
  readonly invocations: readonly FakeToolSandboxInvocation[]
  readonly cancellations: ReadonlyArray<{
    readonly agentId: string
    readonly invocationId: string
    readonly generation: number
  }>
  readonly closes: ReadonlyArray<{
    readonly agentId: string
    readonly generation: number
  }>
  launch: ToolSandboxLauncher['launch']
  crash(
    agentId: string,
    exit?: ToolSandboxProcessExit
  ): Promise<void>
  waitForInvocation(invocationId: string, agentId?: string): Promise<void>
}

export interface CreateFakeToolSandboxLauncherOptions {
  readonly holdInvocations?: boolean
  readonly invoke?: (
    input: FakeToolSandboxInvocation
  ) => Promise<ToolSandboxResult>
}

interface FakeProcessState {
  readonly agentId: string
  readonly generation: number
  readonly exit: ReturnType<typeof deferred<ToolSandboxProcessExit>>
  readonly held: Map<string, ReturnType<typeof deferred<ToolSandboxResult>>>
  exited: boolean
}

export function createFakeToolSandboxLauncher(
  options: CreateFakeToolSandboxLauncherOptions = {}
): FakeToolSandboxLauncher {
  const launches: Array<{ agentId: string; generation: number }> = []
  const invocations: FakeToolSandboxInvocation[] = []
  const cancellations: Array<{
    agentId: string
    invocationId: string
    generation: number
  }> = []
  const closes: Array<{ agentId: string; generation: number }> = []
  const processes: FakeProcessState[] = []
  const invocationWaiters = new Map<string, Array<() => void>>()

  async function launch({
    agentId,
    generation
  }: {
    readonly agentId: string
    readonly generation: number
  }): Promise<LaunchedToolSandbox> {
    const state: FakeProcessState = {
      agentId,
      generation,
      exit: deferred<ToolSandboxProcessExit>(),
      held: new Map(),
      exited: false
    }
    launches.push({ agentId, generation })
    processes.push(state)
    return {
      agentId,
      generation,
      exited: state.exit.promise,
      async cleanup() {},
      sandbox: {
        async configure() {
          return { generation }
        },
        async ready() {
          return {
            component: 'tool-sandbox',
            runtime: 'bare',
            generation,
            processId: generation,
            protocolVersion: 1
          }
        },
        async invoke(input) {
          const invocation = { ...input, agentId }
          invocations.push(invocation)
          notifyInvocation(invocationWaiters, invocation)
          if (options.invoke) return options.invoke(invocation)
          if (options.holdInvocations) {
            const held = deferred<ToolSandboxResult>()
            state.held.set(input.invocationId, held)
            return held.promise
          }
          return {
            status: 'success',
            invocationId: input.invocationId,
            generation: input.generation,
            value: input.input
          }
        },
        async cancel(input) {
          cancellations.push({ agentId, ...input })
        },
        async close() {
          if (state.exited) return
          closes.push({ agentId, generation })
          state.exited = true
          rejectHeld(state, 'sandbox closed')
          state.exit.resolve({ code: 0, signal: null })
        }
      }
    }
  }

  return {
    launches,
    invocations,
    cancellations,
    closes,
    launch,
    async crash(agentId, exit = { code: 1, signal: null }) {
      const state = latestLiveProcess(processes, agentId)
      if (!state) throw new Error(`no live fake sandbox for ${agentId}`)
      state.exited = true
      if (options.holdInvocations) rejectHeld(state, 'sandbox crashed')
      state.exit.resolve(exit)
      await Promise.resolve()
    },
    async waitForInvocation(invocationId, agentId) {
      if (
        invocations.some(
          (entry) =>
            entry.invocationId === invocationId &&
            (agentId === undefined || entry.agentId === agentId)
        )
      ) {
        return
      }
      await new Promise<void>((resolve) => {
        const key = waiterKey(invocationId, agentId)
        const waiters = invocationWaiters.get(key) ?? []
        waiters.push(resolve)
        invocationWaiters.set(key, waiters)
      })
    }
  }
}

function latestLiveProcess(
  processes: readonly FakeProcessState[],
  agentId: string
) {
  for (let index = processes.length - 1; index >= 0; index--) {
    const state = processes[index]
    if (state?.agentId === agentId && !state.exited) return state
  }
  return undefined
}

function notifyInvocation(
  waiters: Map<string, Array<() => void>>,
  invocation: FakeToolSandboxInvocation
) {
  for (const key of [
    waiterKey(invocation.invocationId),
    waiterKey(invocation.invocationId, invocation.agentId)
  ]) {
    const listeners = waiters.get(key) ?? []
    waiters.delete(key)
    for (const listener of listeners) listener()
  }
}

function waiterKey(invocationId: string, agentId?: string) {
  return `${agentId ?? '*'}\0${invocationId}`
}

function rejectHeld(state: FakeProcessState, message: string) {
  for (const [invocationId, held] of state.held) {
    held.resolve({
      status: 'error',
      invocationId,
      generation: state.generation,
      error: { code: 'SANDBOX_EXITED', message }
    })
  }
  state.held.clear()
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
