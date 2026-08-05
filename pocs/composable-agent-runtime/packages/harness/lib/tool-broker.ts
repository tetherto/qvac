import type { ToolGrant } from '@qvac/agents'
import type { HarnessAgentRegistration } from './agent-registration.ts'
import type { SkillCatalogEntry } from './skills/catalog.ts'
import { parseToolGrant } from './skills/tool-grants.ts'

/**
 * Tool contracts live in @qvac/agents, which owns the loop, the guards, and
 * approval semantics. Harness re-exports them under its own names so consumers
 * of the execution runtime do not have to reach across packages for a type.
 */
export type {
  AgentTool as HarnessTool,
  AgentToolCall as HarnessToolCall,
  AgentToolGate as HarnessToolGate,
  AgentToolInvocation as HarnessToolInvocation,
  AgentToolProgress as HarnessToolProgress,
  AgentToolPropertySchema as HarnessToolPropertySchema,
  AgentToolSchema as HarnessToolSchema,
  ToolApprovalPort as HarnessToolApprovalPort,
  ToolBrokerPort as HarnessToolBrokerPort
} from '@qvac/agents'
export { createToolGate, memoizeToolApproval } from '@qvac/agents'

export function validateSelectedSkills(
  registration: HarnessAgentRegistration,
  catalog: readonly SkillCatalogEntry[]
) {
  const knownSkills = new Set(catalog.map((skill) => skill.name))
  for (const skillName of registration.skills) {
    if (!knownSkills.has(skillName)) throw new Error(`unknown skill: ${skillName}`)
  }
}

/**
 * Resolves which capabilities a run holds from the skills it selected. Which
 * grants exist is a skill concern and stays here; what a grant permits is
 * enforced by the agents tool gate.
 */
export function grantsFor(
  selectedSkills: readonly string[],
  catalog: readonly SkillCatalogEntry[]
): ReadonlyMap<string, readonly ToolGrant[]> {
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
