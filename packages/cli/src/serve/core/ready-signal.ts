import { closeSync, writeSync } from 'node:fs'

// Written to a pipe the spawning process owns, so only the child it started can
// report the bound port. Kept off stdout, which carries human-readable logs.
export const READY_PREFIX = 'QVAC_SERVE_READY '

export interface ReadySignal {
  readonly port: number
  readonly pid: number
}

export function writeReadySignal(fd: number, signal: ReadySignal): void {
  const line = Buffer.from(`${READY_PREFIX}${JSON.stringify(signal)}\n`, 'utf8')
  let written = 0
  try {
    while (written < line.length) {
      try {
        written += writeSync(fd, line, written)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
      }
    }
  } finally {
    closeSync(fd)
  }
}
