import type { AgentDefinition, AgentToolPolicy } from '@qvac/agents'

export interface HarnessAgentWorkflowOperation {
  readonly id: string
  readonly prompt: string
}

export type HarnessToolPolicy = AgentToolPolicy

export interface HarnessAgentRegistration {
  readonly id: string
  readonly model: string
  readonly instructions?: string
  readonly workflow?: readonly HarnessAgentWorkflowOperation[]
  readonly skills: readonly string[]
  readonly toolPolicy: HarnessToolPolicy
  /** Maximum tool rounds per operation. Defaults to the agents turn budget. */
  readonly turnBudget?: number
}

export function agentDefinitionFromRegistration(
  registration: HarnessAgentRegistration
): AgentDefinition {
  return {
    id: registration.id,
    model: registration.model,
    ...(registration.instructions ? { instructions: registration.instructions } : {}),
    ...(registration.workflow
      ? {
          workflow: registration.workflow.map((operation) => ({
            id: operation.id,
            prompt: operation.prompt
          }))
        }
      : {}),
    toolPolicy: {
      allow: [...registration.toolPolicy.allow],
      requireApproval: [...registration.toolPolicy.requireApproval]
    },
    ...(registration.turnBudget === undefined
      ? {}
      : { turnBudget: registration.turnBudget })
  }
}

export function copyAgentRegistration(
  registration: HarnessAgentRegistration
): HarnessAgentRegistration {
  return {
    id: registration.id,
    model: registration.model,
    ...(registration.instructions ? { instructions: registration.instructions } : {}),
    ...(registration.workflow
      ? { workflow: registration.workflow.map((operation) => ({ ...operation })) }
      : {}),
    skills: [...registration.skills],
    toolPolicy: {
      allow: [...registration.toolPolicy.allow],
      requireApproval: [...registration.toolPolicy.requireApproval]
    },
    ...(registration.turnBudget === undefined
      ? {}
      : { turnBudget: registration.turnBudget })
  }
}
