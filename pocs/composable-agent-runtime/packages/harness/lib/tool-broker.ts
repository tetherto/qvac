import type { HarnessAgentRegistration } from './agent-registration.ts'
import type { SkillCatalogEntry } from './skills/catalog.ts'
import { parseToolGrant, type ToolGrant } from './skills/tool-grants.ts'
import type { HarnessAbortSignal, HarnessJsonValue } from './types.ts'

export interface HarnessToolPropertySchema {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  readonly description?: string
  readonly enum?: readonly (string | number | boolean | null)[]
}

export interface HarnessToolSchema {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, HarnessToolPropertySchema>>
    readonly required?: readonly string[]
  }
}

export interface HarnessTool {
  readonly schema: HarnessToolSchema
  validateCall?(call: HarnessToolCall): void
}

export interface HarnessToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Readonly<Record<string, HarnessJsonValue>>
}

export interface HarnessToolProgress {
  readonly step: number
  readonly totalSteps: number
  readonly elapsedMs: number
}

export interface HarnessToolInvocation {
  readonly agentId: string
  readonly runId: string
  readonly operationId: string
  readonly call: HarnessToolCall
  readonly grants: readonly ToolGrant[]
  readonly signal: HarnessAbortSignal
  readonly reportProgress?: (progress: HarnessToolProgress) => Promise<void>
}

export interface HarnessToolBrokerPort {
  execute(input: HarnessToolInvocation): Promise<HarnessJsonValue>
  cancel(input: {
    readonly agentId: string
    readonly runId: string
    readonly operationId: string
  }): Promise<void>
  close(): Promise<void>
}

export interface HarnessToolApprovalPort {
  approve(input: HarnessToolInvocation): Promise<boolean>
}

export interface HarnessToolGate {
  readonly schemas: readonly HarnessToolSchema[]
  execute(input: Omit<HarnessToolInvocation, 'grants'>): Promise<HarnessJsonValue>
  cancel(input: {
    readonly agentId: string
    readonly runId: string
    readonly operationId: string
  }): Promise<void>
}

interface CreateToolGateOptions {
  readonly registration: HarnessAgentRegistration
  readonly catalog: readonly SkillCatalogEntry[]
  readonly tools: readonly HarnessTool[]
  readonly broker: HarnessToolBrokerPort
  readonly approval?: HarnessToolApprovalPort
}

export function validateSelectedSkills(
  registration: HarnessAgentRegistration,
  catalog: readonly SkillCatalogEntry[]
) {
  const knownSkills = new Set(catalog.map((skill) => skill.name))
  for (const skillName of registration.skills) {
    if (!knownSkills.has(skillName)) throw new Error(`unknown skill: ${skillName}`)
  }
}

export function createToolGate({
  registration,
  catalog,
  tools,
  broker,
  approval
}: CreateToolGateOptions): HarnessToolGate {
  validateSelectedSkills(registration, catalog)
  const grantsByName = grantsFor(registration.skills, catalog)
  const allowed = new Set(registration.toolPolicy.allow)
  const requireApproval = new Set(registration.toolPolicy.requireApproval)
  const toolsByName = new Map(tools.map((tool) => [tool.schema.name, tool]))
  for (const name of grantsByName.keys()) {
    if (allowed.has(name) && !toolsByName.has(name)) {
      throw new Error(`allowed tool lacks a registered schema: ${name}`)
    }
  }
  const schemas = [...grantsByName.keys()]
    .filter((name) => allowed.has(name))
    .map((name) => toolsByName.get(name)?.schema)
    .filter((schema): schema is HarnessToolSchema => schema !== undefined)

  return {
    schemas,
    async execute(input) {
      if (input.signal.aborted) throw new Error('tool call aborted')
      const grants = grantsByName.get(input.call.name)
      if (!grants?.length) throw new Error(`tool is not granted: ${input.call.name}`)
      if (!allowed.has(input.call.name)) {
        throw new Error(`tool is denied by policy: ${input.call.name}`)
      }
      const tool = toolsByName.get(input.call.name)
      if (!tool) throw new Error(`unknown tool: ${input.call.name}`)
      tool.validateCall?.(input.call)

      const invocation: HarnessToolInvocation = { ...input, grants }
      if (requireApproval.has(input.call.name)) {
        const approved = approval ? await approval.approve(invocation) : false
        if (!approved) throw new Error(`tool approval denied: ${input.call.name}`)
      }
      if (input.signal.aborted) throw new Error('tool call aborted')
      return broker.execute(invocation)
    },
    cancel(input) {
      return broker.cancel(input)
    }
  }
}

export function memoizeToolApproval(
  approval: HarnessToolApprovalPort
): HarnessToolApprovalPort {
  const decisions = new WeakMap<object, Promise<boolean>>()
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

function grantsFor(
  selectedSkills: readonly string[],
  catalog: readonly SkillCatalogEntry[]
) {
  const selected = new Set(selectedSkills)
  const grants = new Map<string, ToolGrant[]>()
  for (const skill of catalog) {
    if (!selected.has(skill.name)) continue
    for (const rawGrant of skill.tools) {
      const grant = parseToolGrant(rawGrant)
      const existing = grants.get(grant.name) ?? []
      existing.push(grant)
      grants.set(grant.name, existing)
    }
  }
  return grants
}
