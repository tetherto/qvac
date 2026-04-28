export interface {{DISPLAY_NAME}}Options {
  files: { model: string[] }
  config?: Record<string, unknown>
  logger?: unknown
  opts?: { stats?: boolean }
}

export interface {{DISPLAY_NAME}}RunInput {
  name?: string | null
}

export interface {{DISPLAY_NAME}}RunResult {
  text: string
}

export interface QvacResponse {
  await(): Promise<{{DISPLAY_NAME}}RunResult>
  cancel(): Promise<void>
  on(event: string, listener: (...args: unknown[]) => void): this
}

export class {{DISPLAY_NAME}} {
  constructor (options: {{DISPLAY_NAME}}Options)
  load (): Promise<void>
  run (input?: {{DISPLAY_NAME}}RunInput): Promise<QvacResponse>
  pause (): Promise<void>
  cancel (): Promise<void>
  unload (): Promise<void>
  getState (): { configLoaded: boolean }
}

export function normalizeName (name: unknown): string

declare const _default: typeof {{DISPLAY_NAME}}
export default _default
