import type {
  AgentJsonValue,
  AgentTool,
  AgentToolInvocation,
  AgentToolRunKey,
  ToolGrant
} from '@qvac/agents'
import type { SdkRuntimePort } from '../sdk-runtime-port.ts'
import type { SkillCatalogEntry } from './catalog.ts'

/**
 * What a skill contributes to the sandbox it runs in. Deliberately the subset
 * of the launcher's per-agent permissions that a skill can own: resource roots
 * are per-agent and stay with the composer.
 */
export interface SkillSandboxContribution {
  readonly executablePaths?: readonly string[]
  readonly readOnlyRoots?: readonly string[]
  readonly writeRoots?: readonly string[]
  readonly loopbackPorts?: readonly number[]
  readonly unixSocketPaths?: readonly string[]
  readonly enabledTools?: readonly string[]
  /** This skill's slice of the sandbox configuration, namespaced by the composer. */
  configuration?(paths: {
    readonly scratchRoot: string
    readonly agentId: string
  }): Readonly<Record<string, AgentJsonValue>>
}

export interface SkillPermissionRequest {
  readonly agentId: string
  /** Only the grants this skill confers, already parsed. */
  readonly grants: readonly ToolGrant[]
}

export interface SkillHostContribution {
  readonly tools: readonly AgentTool[]
  /** Tool names routed into the per-agent sandbox child. */
  readonly sandboxTools?: readonly string[]
  /** Tool names executed in the harness process instead of a sandbox. */
  readonly sharedTools?: readonly string[]
  /** Tools this skill always requires approval for, whatever the agent policy says. */
  readonly requiresApproval?: readonly string[]
  execute?(input: AgentToolInvocation): Promise<AgentJsonValue>
  cancel?(input: AgentToolRunKey): Promise<void>
  permissions?(
    input: SkillPermissionRequest
  ): SkillSandboxContribution | Promise<SkillSandboxContribution>
  close?(): Promise<void>
}

export interface SkillHostContext {
  readonly sdk: SdkRuntimePort
  readonly entry: SkillCatalogEntry
  /** This skill's opaque slice of the host configuration. */
  readonly config: Readonly<Record<string, AgentJsonValue>>
  readonly temporaryRoot?: string
}

/**
 * The host half of a skill. Applications own these; Harness only knows how to
 * compose them.
 */
export interface SkillHostProvider {
  /** Must equal the skill's directory name in the bundle. */
  readonly name: string
  create(
    context: SkillHostContext
  ): SkillHostContribution | Promise<SkillHostContribution>
}
