import type { AgentAbortSignal } from './types.ts'

export type AgentJsonValue =
  | boolean
  | number
  | string
  | null
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue }

export interface AgentToolPropertySchema {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  readonly description?: string
  readonly enum?: readonly (string | number | boolean | null)[]
}

export interface AgentToolSchema {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, AgentToolPropertySchema>>
    readonly required?: readonly string[]
  }
}

export interface AgentToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Readonly<Record<string, AgentJsonValue>>
}

export interface AgentTool {
  readonly schema: AgentToolSchema
  validateCall?(call: AgentToolCall): void
}

export interface AgentToolProgress {
  readonly step: number
  readonly totalSteps: number
  readonly elapsedMs: number
}

/**
 * A capability a selected skill confers on a tool. Agents treats a grant as an
 * opaque capability scope; deciding which grants a run holds is the caller's
 * concern.
 */
export interface ToolGrant {
  readonly name: string
  readonly scope: string | null
}

export interface AgentToolRunKey {
  readonly agentId: string
  readonly runId: string
  readonly operationId: string
}

export interface AgentToolInvocation extends AgentToolRunKey {
  readonly call: AgentToolCall
  readonly grants: readonly ToolGrant[]
  readonly signal: AgentAbortSignal
  readonly reportProgress?: (progress: AgentToolProgress) => Promise<void>
}

export interface ToolBrokerPort {
  execute(input: AgentToolInvocation): Promise<AgentJsonValue>
  cancel(input: AgentToolRunKey): Promise<void>
  close(): Promise<void>
}

export interface ToolApprovalPort {
  approve(input: AgentToolInvocation): Promise<boolean>
}

export interface AgentToolPolicy {
  readonly allow: readonly string[]
  readonly requireApproval: readonly string[]
}

/**
 * Runtime tooling for one run. The caller resolves which grants the run holds
 * (from skills, capabilities, or anything else) and supplies the ports; agents
 * owns the guard, approval, and budget semantics applied over them.
 */
export interface AgentToolingOptions {
  readonly tools?: readonly AgentTool[]
  readonly grants?: ReadonlyMap<string, readonly ToolGrant[]>
  readonly broker?: ToolBrokerPort
  readonly approval?: ToolApprovalPort
  /** Tools that always require approval regardless of the agent's policy. */
  readonly mandatoryApproval?: ReadonlySet<string>
}

export interface AgentToolGateEvents {
  onApprovalRequested?(input: AgentToolInvocation): Promise<void> | void
  onApprovalResolved?(
    input: AgentToolInvocation,
    approved: boolean
  ): Promise<void> | void
}

export interface AgentToolGate {
  readonly schemas: readonly AgentToolSchema[]
  execute(input: Omit<AgentToolInvocation, 'grants'>): Promise<AgentJsonValue>
  cancel(input: AgentToolRunKey): Promise<void>
}

interface CreateToolGateOptions extends AgentToolingOptions {
  readonly policy: AgentToolPolicy
  readonly events?: AgentToolGateEvents
}

// Module constant rather than an inline `new Map<...>()` default: the Bare
// type stripper cannot erase generic type arguments in a destructuring default.
const NO_GRANTS: ReadonlyMap<string, readonly ToolGrant[]> = new Map()

export function createToolGate({
  tools = [],
  grants = NO_GRANTS,
  broker,
  approval,
  mandatoryApproval,
  policy,
  events
}: CreateToolGateOptions): AgentToolGate {
  const allowed = new Set(policy.allow)
  const requireApproval = new Set([
    ...policy.requireApproval,
    ...(mandatoryApproval ?? [])
  ])
  const toolsByName = new Map(tools.map((tool) => [tool.schema.name, tool]))
  for (const name of grants.keys()) {
    if (allowed.has(name) && !toolsByName.has(name)) {
      throw new Error(`allowed tool lacks a registered schema: ${name}`)
    }
  }
  const schemas = [...grants.keys()]
    .filter((name) => allowed.has(name))
    .map((name) => toolsByName.get(name)?.schema)
    .filter((schema): schema is AgentToolSchema => schema !== undefined)

  return {
    schemas,
    async execute(input) {
      if (input.signal.aborted) throw new Error('tool call aborted')
      const held = grants.get(input.call.name)
      if (!held?.length) throw new Error(`tool is not granted: ${input.call.name}`)
      if (!allowed.has(input.call.name)) {
        throw new Error(`tool is denied by policy: ${input.call.name}`)
      }
      const tool = toolsByName.get(input.call.name)
      if (!tool) throw new Error(`unknown tool: ${input.call.name}`)
      tool.validateCall?.(input.call)

      const invocation: AgentToolInvocation = { ...input, grants: held }
      if (requireApproval.has(input.call.name)) {
        await events?.onApprovalRequested?.(invocation)
        const approved = approval ? await approval.approve(invocation) : false
        await events?.onApprovalResolved?.(invocation, approved)
        if (!approved) throw new Error(`tool approval denied: ${input.call.name}`)
      }
      if (input.signal.aborted) throw new Error('tool call aborted')
      if (!broker) throw new Error(`no tool broker configured for ${input.call.name}`)
      return broker.execute(invocation)
    },
    async cancel(input) {
      await broker?.cancel(input)
    }
  }
}

export function memoizeToolApproval(approval: ToolApprovalPort): ToolApprovalPort {
  const decisions: WeakMap<object, Promise<boolean>> = new WeakMap()
  return {
    approve(input) {
      const existing = decisions.get(input)
      if (existing) return existing
      const decision = approval.approve(input)
      decisions.set(input, decision)
      return decision
    }
  }
}
