import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SOCKET_FILE_NAME = 'worker.sock'

/**
 * Create the endpoint the worker dials.
 *
 * On Unix the socket sits in a fresh directory that only the current user can
 * enter, so other local users cannot reach it whatever the process umask. On
 * Windows it is a named pipe, whose default access already denies other users.
 */
export function createIPCSocketPath(): string {
  if (process.platform === 'win32') {
    const timestamp = Date.now().toString(36)
    const randomSuffix = randomBytes(2).toString('hex')
    return `\\\\.\\pipe\\qvac-worker-${process.pid}-${timestamp}-${randomSuffix}`
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-worker-'))
  return path.join(dir, SOCKET_FILE_NAME)
}

/** Remove the socket file and its directory. Named pipes have nothing to remove. */
export function removeIPCSocketPath(socketPath: string): void {
  if (process.platform === 'win32') return
  const dir = path.dirname(socketPath)
  fs.rmSync(socketPath, { force: true })
  if (fs.existsSync(dir)) fs.rmdirSync(dir)
}
