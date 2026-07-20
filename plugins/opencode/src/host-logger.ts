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

export function createHostLogger(params: {
  debug: boolean
  logFile: string | undefined
}): HostLogger {
  const write = (message: string): void => writeFileLog(params.logFile, message)
  return {
    log: (message: string): void => {
      process.stdout.write(`${message}\n`)
      write(message)
    },
    trace: (message: string): void => {
      if (params.debug) process.stdout.write(`${message}\n`)
      write(message)
    },
    error: (message: string): void => {
      process.stderr.write(`${message}\n`)
      write(message)
    }
  }
}
