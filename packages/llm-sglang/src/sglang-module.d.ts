declare module '@qvac/sglang' {
  export interface ServerProcess {
    kill(signal?: NodeJS.Signals): boolean
    exitCode: number | null
    on(event: 'exit', listener: (code: number | null) => void): void
  }

  export function startServer(options: Record<string, unknown>): ServerProcess
}
