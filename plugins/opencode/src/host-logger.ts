import { appendFileSync } from 'node:fs'

export interface HostLogger {
  log: (message: string) => void
  trace: (message: string) => void
  error: (message: string) => void
}

function writeFileLog(logFile: string | undefined, message: string): void {
  if (logFile === undefined) return
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  return String(err)
}

// Milestones and traces only ever describe requests and timings — never the
// proxy token or the managed serve key, either of which would otherwise reach
// the log file and OpenCode's mirrored stderr.
export function createHostLogger(params: {
  debug: boolean
  logFile: string | undefined
  out?: (text: string) => void
  err?: (text: string) => void
}): HostLogger {
  const out = params.out ?? ((text: string): void => void process.stdout.write(text))
  const err = params.err ?? ((text: string): void => void process.stderr.write(text))
  const write = (message: string): void => writeFileLog(params.logFile, message)
  return {
    log: (message: string): void => {
      out(`${message}\n`)
      write(message)
    },
    trace: (message: string): void => {
      if (params.debug) out(`${message}\n`)
      write(message)
    },
    error: (message: string): void => {
      err(`${message}\n`)
      write(message)
    }
  }
}
