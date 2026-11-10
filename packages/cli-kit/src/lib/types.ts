import type { AccessPolicy } from '@qvac/harness'
import type { AgentTargetConfig } from '@qvac/harness/plugins/external-agents'
import type { Capabilities } from '@qvac/core/client'
import type { HarnessPlugin } from '@qvac/harness/plugins'

export type Agent = NonNullable<Awaited<ReturnType<Capabilities['listAgents']>>['agents']>[number]
export type AgentProfile = Partial<
  Pick<
    Agent,
    'name' | 'reasoning' | 'approvalMode' | 'ctxSize' | 'disabledToolsets' | 'enabledSkills'
  >
> & {
  instructions?: string | undefined
  // each tool's settings by tool name, e.g. { edit_file: { forms: 'all' } }
  toolConfigs?: Record<string, Record<string, unknown>> | undefined
}
export interface FolderGrant {
  path: string
  write?: boolean | undefined
}
export interface PluginEntry {
  id?: string | undefined
  name?: string | undefined
  use?: string | undefined
  module?: string | undefined
  export?: string | undefined
  enabled?: boolean | undefined
  optional?: boolean | undefined
  inline?: number | undefined
  plugin?: HarnessPlugin | undefined
  read?: string[] | undefined
  options?: Record<string, unknown> | undefined
}
export type PluginSpec = string | PluginEntry | HarnessPlugin
export interface CoreConfig {
  model?: string | undefined
  agentId?: string | undefined
  agent?: AgentProfile | undefined
  dataDir?: string | undefined
  modelsDir?: string | undefined
  deviceName?: string | undefined
  accountName?: string | undefined
  autoDownloadModels?: boolean | undefined
  folders?: FolderGrant[] | undefined
}
export type DelegationTarget = AgentTargetConfig
export interface HarnessConfig {
  plugins?: PluginSpec[] | undefined
  maxToolRounds?: number | undefined
  delegation?:
    | {
        targets?: DelegationTarget[]
        slots?: number
        maxExternal?: number
        enabled?: boolean
        read?: string[]
      }
    | undefined
  policy?: AccessPolicy | undefined
  planMode?: boolean | undefined
  reasoningBudget?: number | undefined
  thinking?: string | undefined
  wording?: Record<string, unknown> | undefined
  llm?: Record<string, unknown> | undefined
  allowUnsandboxedShell?: boolean | undefined
  [key: string]: unknown
}
export interface TuiConfig {
  startPage?: string | undefined
  theme?: string | undefined
  suggestions?: boolean | undefined
  extensions?: unknown[] | undefined
  plugins?: unknown
  [key: string]: unknown
}
export interface WorkbenchConfig {
  core: CoreConfig
  harness: HarnessConfig
  tui: TuiConfig
  defaults?: boolean | undefined
  [key: string]: unknown
}
export interface LoadedConfig {
  config: WorkbenchConfig
  sources: Record<string, string>
  configPath: string | null
}
