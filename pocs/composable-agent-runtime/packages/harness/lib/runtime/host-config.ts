import type { AgentJsonValue } from '@qvac/agents'

/**
 * The launch payload the harness worker receives. Skill-agnostic on purpose:
 * Harness never reads inside `skills`, it hands each slice to the provider of
 * the same name. Carried as base64 argv, so keep it to paths and flags; a skill
 * needing a large payload should write a file under `temporaryRoot` instead.
 */
export interface HarnessHostConfig {
  readonly platform?: string
  readonly bareExecutable?: string
  readonly temporaryRoot?: string
  readonly sandboxIdleTimeoutMs?: number
  /** Host ceiling on tool rounds; the effective budget is the lower of this and the agent's. */
  readonly turnBudget?: number
  readonly skills?: Readonly<Record<string, Record<string, AgentJsonValue>>>
}

/** Injected by the launcher, which alone knows the built bundle path. */
export interface WireHostConfig extends HarnessHostConfig {
  readonly sandboxChildEntry?: string
}
