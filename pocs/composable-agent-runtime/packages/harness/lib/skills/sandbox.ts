import type { AgentJsonValue } from '@qvac/agents'
import type {
  ToolSandboxExecutionRequest,
  ToolSandboxExecutor
} from '../tool-sandbox/wire.ts'

export interface SkillSandboxContext {
  /** This skill's slice of the sandbox configuration. */
  readonly configuration: Readonly<Record<string, AgentJsonValue>>
  readonly scratchRoot: string
}

/**
 * The in-sandbox half of a skill. Kept in its own module from the host half so
 * a sandbox bundle never pulls in host-side code such as outbound transports.
 */
export interface SkillSandboxProvider {
  readonly name: string
  readonly tools: readonly string[]
  create(context: SkillSandboxContext): ToolSandboxExecutor
}

interface SandboxEnvelope {
  readonly scratchRoot?: unknown
  readonly skills?: Readonly<Record<string, Record<string, AgentJsonValue>>>
}

/**
 * Builds the `configure` hook the sandbox wire already expects. Providers are
 * instantiated inside configure, not at module import, so a bad configuration
 * surfaces at launch rather than on the first tool call.
 */
export function createSkillSandboxExecutor(
  providers: readonly SkillSandboxProvider[]
) {
  const byName = new Map(providers.map((provider) => [provider.name, provider]))

  return function configure(
    configuration: Readonly<Record<string, AgentJsonValue>>
  ): ToolSandboxExecutor {
    const envelope = configuration as SandboxEnvelope
    const scratchRoot =
      typeof envelope.scratchRoot === 'string' ? envelope.scratchRoot : ''
    if (!scratchRoot) throw new Error('sandbox configuration is missing scratchRoot')
    const slices = envelope.skills ?? {}

    const executors = new Map<string, ToolSandboxExecutor>()
    const created: ToolSandboxExecutor[] = []
    for (const [name, slice] of Object.entries(slices)) {
      const provider = byName.get(name)
      if (!provider) throw new Error(`sandbox has no provider for skill: ${name}`)
      const executor = provider.create({ configuration: slice, scratchRoot })
      created.push(executor)
      for (const tool of provider.tools) {
        if (executors.has(tool)) {
          throw new Error(`duplicate sandbox tool across skills: ${tool}`)
        }
        executors.set(tool, executor)
      }
    }

    return {
      async invoke(input: ToolSandboxExecutionRequest) {
        const executor = executors.get(input.toolName)
        if (!executor) {
          throw new Error(`sandbox tool is not configured: ${input.toolName}`)
        }
        return executor.invoke(input)
      },
      async close() {
        const results = await Promise.allSettled(
          created.map((executor) => executor.close?.())
        )
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }
    }
  }
}
