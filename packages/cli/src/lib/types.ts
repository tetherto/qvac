import type { AccessPolicy } from '@qvac/harness'
import type { AgentTargetConfig } from '@qvac/harness/plugins/external-agents'
import type { Client, Capabilities } from '@qvac/core/client'
import type { HarnessPlugin } from '@qvac/harness/plugins'
import type { CommandIO } from '../cli/io.js'

export type Agent = NonNullable<Awaited<ReturnType<Capabilities['listAgents']>>['agents']>[number]
export type AgentProfile = Partial<
  Pick<Agent, 'name' | 'reasoning' | 'approvalMode' | 'ctxSize' | 'disabledToolsets'>
> & { instructions?: string | undefined }
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
export interface LaunchOptions {
  standalone?: boolean | undefined
  tty?: { stdin: boolean; stdout: boolean; stderr: boolean } | undefined
  prompt?: string | undefined
  initialPrompt?: string | undefined
  stdinPiped?: boolean | undefined
  dataDir?: string | undefined
  storage?: string | undefined
  deviceName?: string | undefined
  accountName?: string | undefined
  model?: string | undefined
  modelChosen?: boolean | undefined
  configFile?: string | undefined
  runtimeConfig?: string | undefined
  config?: WorkbenchConfig | undefined
  sources?: Record<string, string> | undefined
  configPath?: string | null | undefined
  join?: string | null | undefined
  deviceJoin?: string | null | undefined
  bootstrap?: string | undefined
  mode?: string | undefined
  chat?: string | undefined
  tail?: number | string | undefined
  create?: boolean | undefined
  json?: boolean | undefined
  nonInteractive?: boolean | undefined
  yes?: boolean | undefined
  noColor?: boolean | undefined
  noDefaultModels?: boolean | undefined
  skipSetup?: boolean | undefined
  fakeModels?: boolean | undefined
  temp?: boolean | undefined
  print?: boolean | undefined
  continue?: boolean | undefined
  resume?: boolean | undefined
  newChat?: boolean | undefined
  follow?: boolean | undefined
  version?: string | boolean | undefined
  command?: string | null | undefined
  action?: string | null | undefined
  words?: string[] | undefined
  columns?: number | undefined
  startPage?: string | undefined
  theme?: string | undefined
  launcher?: { runtime: string; script?: string | undefined } | undefined
  logVerbose?: boolean | undefined
  entries?:
    | { release?: string; skill: string; cliSkill?: string; harness: string; sidecar: string }
    | undefined
}
export interface CoreHost {
  engine: Client
  exited: Promise<number>
  close(): Promise<void>
  skills(
    agentId: string,
    model: string,
    meshId: string
  ): Promise<NonNullable<Awaited<ReturnType<Capabilities['skills']>>['skills']>>
  deviceId: Uint8Array | null
  meshInvite: string | null
  modelName: string | null
  deviceName: string
  cliSkills: string[]
  root: string
  storagePath: string
  logFile: string
  connectMs: number
  configure(): Promise<void>
}
export interface ParsedCommand {
  command: string
  action: string | null
  words: string[]
  options: LaunchOptions
  where: 'launcher' | 'core' | 'app'
}
export interface LauncherKit {
  root: string
  version: string
  node: string
  app(options: LaunchOptions): Promise<void>
  usage(message: string): never
  loadConfig(file?: string): Promise<LoadedConfig>
  dataDir(options: LaunchOptions, config: CoreConfig): string
  supervise(child: import('node:child_process').ChildProcess): void
  fs: typeof import('node:fs')
  process: typeof import('node:process')
  AbortController: typeof globalThis.AbortController
}
export interface RuntimeOptions extends LaunchOptions {
  dataDir: string
  command: string
  words: string[]
  config: WorkbenchConfig
}
export type CoreRunner = (
  host: CoreHost,
  options: RuntimeOptions,
  io: CommandIO
) => Promise<number | void> | number | void
export type LauncherRunner = (parsed: ParsedCommand, kit: LauncherKit) => Promise<void> | void
