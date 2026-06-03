import { unlinkSync } from 'node:fs'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Managed serves record their PID under here so a later supervisor start can
// detect and sweep processes orphaned by a crashed/SIGKILL'd parent (where the
// normal teardown handlers never ran).
export function managedServesDir (): string {
  return join(homedir(), '.qvac', 'managed-serves')
}

export interface ServeRecord {
  readonly pid: number
  readonly port: number
  readonly configPath: string
  readonly startedAt: string
}

function recordPath (pid: number): string {
  return join(managedServesDir(), `${pid}.json`)
}

// `kill(pid, 0)` is the portable liveness probe: it sends no signal but throws
// ESRCH when the process is gone. EPERM means it exists but we can't signal it
// (still "alive" for our purposes).
export function isProcessAlive (pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

export async function recordServe (record: ServeRecord): Promise<void> {
  await mkdir(managedServesDir(), { recursive: true })
  await writeFile(recordPath(record.pid), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

export async function forgetServe (pid: number): Promise<void> {
  await unlink(recordPath(pid)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err
  })
}

// Synchronous variant for `process.on('exit')`, where async work cannot run.
export function forgetServeSync (pid: number): void {
  try {
    unlinkSync(recordPath(pid))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

// Removes record files whose process is no longer alive. Optionally SIGKILLs
// still-running orphans first (used on supervisor start to reclaim leaked
// serves). Returns the PIDs whose records were removed.
export async function sweepStaleServes (options: { killOrphans?: boolean } = {}): Promise<number[]> {
  const dir = managedServesDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const swept: number[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const pid = Number.parseInt(file.slice(0, -'.json'.length), 10)
    if (!Number.isInteger(pid)) {
      await unlink(join(dir, file)).catch(() => {})
      continue
    }

    if (isProcessAlive(pid)) {
      if (!options.killOrphans) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Process vanished between the liveness probe and the kill — treat as
        // already-dead and sweep the record below.
      }
    }

    await forgetServe(pid)
    swept.push(pid)
  }

  return swept
}
