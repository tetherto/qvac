import { execFileSync } from 'node:child_process'

/** Whether a pid is still running. EPERM means alive but not ours to signal. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

/**
 * Bare worker processes spawned by `parentPid`, by pid.
 *
 * Node-only: import it from `tests/shared/executors/node/`, never from shared
 * code that mobile bundles.
 */
export function findBareChildren(parentPid: number): number[] {
  return process.platform === 'win32'
    ? findBareChildrenWin32(parentPid)
    : findBareChildrenPosix(parentPid)
}

function findBareChildrenPosix(parentPid: number): number[] {
  let pgrepOutput: string
  try {
    pgrepOutput = execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf-8' })
  } catch (error: unknown) {
    // pgrep exits 1 when nothing matched.
    if ((error as { status?: number })?.status === 1) return []
    throw error
  }

  const bare: number[] = []
  for (const line of pgrepOutput.split('\n')) {
    const pid = Number(line.trim())
    if (!pid) continue
    try {
      const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
        encoding: 'utf-8'
      }).trim()
      if (comm.endsWith('bare')) bare.push(pid)
    } catch {
      // exited between pgrep and ps
    }
  }
  return bare
}

function findBareChildrenWin32(parentPid: number): number[] {
  let psOutput: string
  try {
    psOutput = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" ` +
          `| ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`
      ],
      { encoding: 'utf-8' }
    )
  } catch (error: unknown) {
    // `execFileSync` puts the whole command in `message` and leaves stderr out
    // of it, so the reason the query failed is lost unless it is read here.
    const code = (error as { code?: string })?.code
    if (code === 'ENOENT') throw new Error('powershell.exe not found in PATH')
    const msg = (error as { stderr?: string })?.stderr ?? String(error)
    throw new Error(`PowerShell query failed: ${msg}`)
  }

  const bare: number[] = []
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim()
    const sep = trimmed.indexOf('|')
    if (sep === -1) continue
    const pid = Number(trimmed.slice(0, sep))
    const name = trimmed.slice(sep + 1).toLowerCase()
    if (!Number.isNaN(pid) && (name === 'bare' || name === 'bare.exe')) bare.push(pid)
  }
  return bare
}

/** Polls until the worker set matches `want`, or the timeout expires. */
export async function waitForBareChildren(
  parentPid: number,
  want: (pids: number[]) => boolean,
  timeoutMs = 15_000
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let pids = findBareChildren(parentPid)
  while (!want(pids) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    pids = findBareChildren(parentPid)
  }
  return pids
}
