import type { palette } from './theme.js'
import type { Capabilities } from '@qvac/core/client'
import type { Agent } from '../lib/types.js'
import type { ProductOptions } from './app-types.js'

export const SCREEN_KEYS = '↑↓ choose  space toggle  enter open  esc back'
export interface ScreenRow {
  id: string
  label: string
  detail?: string | undefined
  state?: string | undefined
  badge?: { text: string; color: keyof typeof palette } | undefined
}
export interface ScreenContext {
  deviceId: Uint8Array | null
  engine: Capabilities
  agent: Agent
  meshId: string
  chatId: string | null
  options: ProductOptions
  refreshAgent?: (() => Promise<unknown>) | undefined
}
export interface ScreenPrompt {
  label: string
  value?: string | undefined
  secret?: boolean | undefined
  submit(value: string): unknown | Promise<unknown>
}
export interface ScreenPanel {
  title?: string | undefined
  lines?: string[] | undefined
  prompt?: ScreenPrompt | undefined
  confirm?: { label: string; run(): unknown | Promise<unknown> } | undefined
}
export interface ScreenData {
  rows: ScreenRow[]
  note?: string[] | undefined
}
export interface ScreenAction {
  key: string
  label: string
  run(ctx: ScreenContext): unknown | Promise<unknown>
}
export interface Screen {
  title: string
  hint?: string | undefined
  load(ctx: ScreenContext): Promise<ScreenData> | ScreenData
  toggle?: ((ctx: ScreenContext, row: ScreenRow) => unknown | Promise<unknown>) | undefined
  open?:
    | ((ctx: ScreenContext, row: ScreenRow) => Promise<ScreenPanel | void> | ScreenPanel | void)
    | undefined
  actions?: ScreenAction[] | undefined
}
