import type { AgentDefinition } from '@qvac/agents'

export interface HarnessAgentWorkflowOperation {
  readonly id: string
  readonly prompt: string
}

export interface HarnessToolPolicy {
  readonly allow: readonly string[]
  readonly requireApproval: readonly string[]
}

export interface HarnessAgentRegistration {
  readonly id: string
  readonly model: string
  readonly instructions?: string
  readonly workflow?: readonly HarnessAgentWorkflowOperation[]
  readonly skills: readonly string[]
  readonly toolPolicy: HarnessToolPolicy
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
      : {})
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
    }
  }
}
