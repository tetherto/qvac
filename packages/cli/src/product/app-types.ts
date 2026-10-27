import type { PluginState } from '../lib/runtime/plugin-state.js'
import type { Capabilities } from '@qvac/core/client'
import type { Agent, CoreHost, LaunchOptions } from '../lib/types.js'
import type { Screen, ScreenPanel, ScreenPrompt, ScreenRow } from './screen.js'
import type { LoadedExtensions } from './extensions.js'
import type { loadTemplates, loadContextFiles } from '../lib/runtime/resources.js'
import type { canvas } from './theme.js'

export type Frame = ReturnType<typeof canvas>
export type Command =
  | (() => unknown)
  | Command[]
  | { __suspend: () => unknown }
  | { __seq: Command[] }
  | null
  | undefined
  | false
  | ''
export interface KeyMessage {
  type?: string
  is(...names: string[]): boolean
  sequence: string
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}
export interface MouseMessage {
  type: 'mouse'
  x: number
  y: number
  action: string
  button: string
  alt?: boolean
}
export interface Tui {
  style: { width(text: string): number }
  batch(...commands: Command[]): Command
  tick(ms: number, fn: () => unknown): Command
  quit: Command
  suspend?: ((fn: () => unknown) => Command) | undefined
}
export interface Attachment {
  fileName: string
  mimeType: string
  data: Uint8Array
}
export interface Connection {
  engine: Capabilities
  deviceId?: Uint8Array | null | undefined
  setupNames?: { account: string; device: string } | undefined
  configure?: (() => Promise<void>) | undefined
}
export interface PluginStatus {
  id: string
  name: string
  state: string
  source?: string
  error?: string
  tools?: string[]
  shellBlocked?: boolean
}
export interface HostStatus {
  status?: string
  message?: string
  phase?: string
  model?: string
  text?: string
  plugins?: PluginStatus[]
  builtIn?: { id: string; tools?: string[] }[]
  shell?: { blocked?: boolean; reason?: string }
}

export interface UpdateBanner {
  width: number
  state: string
  spinner?: { id: unknown }
  update(msg: unknown): [unknown, Command]
  view(): string
}
export interface ProductOptions extends Omit<LaunchOptions, 'initialPrompt'> {
  initialPrompt?: string | null | undefined
  engine?: Capabilities | undefined
  meshId?: string | undefined
  agent?: Agent | undefined
  deviceId?: Uint8Array | null | undefined
  cwd?: string | undefined
  home?: string | undefined
  screens?: Record<string, Screen> | undefined
  extensions?: LoadedExtensions | undefined
  updateBanner?: UpdateBanner | null | undefined
  platform?: string | undefined
  connect?: (() => Promise<Connection>) | undefined
  restartCore?: (() => Promise<Connection | void>) | undefined
  readHostStatus?: (() => HostStatus | null) | undefined
  loadTemplates?: (() => ReturnType<typeof loadTemplates>) | undefined
  loadContext?: (() => ReturnType<typeof loadContextFiles>) | undefined
  listFiles?: (() => string[]) | undefined
  post?: ((msg: unknown) => void) | undefined
  readText?: ((path: string) => string | null) | undefined
  writeFile?: ((path: string, text: string) => Promise<string>) | undefined
  copyToClipboard?: ((text: string) => Promise<void>) | undefined
  resolveFileAttachment?: ((path: string) => Attachment) | undefined
  resolvePastedFile?: (() => Promise<Attachment | null>) | undefined
  resolveDirectory?: ((path: string) => Promise<string>) | undefined
  editExternal?: ((text: string) => Promise<string | null>) | undefined
  runShell?:
    ((command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>) | undefined
  gitBranch?: (() => string | null) | undefined
  requestRepaint?: (() => void) | undefined
  readPluginState?: (() => PluginState) | undefined
  writePluginState?: ((state: PluginState) => unknown) | undefined
  skills?: CoreHost['skills'] | undefined
}
export interface ActiveScreen {
  name: string
  def: Screen
  rows: ScreenRow[]
  note: string[]
  cursor: number
  busy: boolean
  error: string
  detail: (ScreenPanel & { lines: string[] }) | null
  prompt: (ScreenPrompt & { value: string }) | null
}
export interface PickerItem<T = string | null> {
  label: string
  hint?: string
  value: T
}
export interface Picker<T = string | null> {
  title: string
  items: PickerItem<T>[]
  cursor: number
  filter: string
  onPick(value: T): Command
}
export type WatchFrame<K extends keyof Capabilities> = Capabilities[K] extends (
  ...args: never[]
) => AsyncIterable<infer F>
  ? F
  : never
export type RpcResult<K extends keyof Capabilities> = Capabilities[K] extends (
  ...args: never[]
) => Promise<infer R>
  ? R
  : never
