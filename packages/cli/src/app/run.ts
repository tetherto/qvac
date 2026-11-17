import { spawn } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { constants } from 'node:os'

const WINDOWS = process.platform === 'win32'
const FORWARDED_SIGNALS: NodeJS.Signals[] = WINDOWS ? ['SIGINT'] : ['SIGINT', 'SIGTERM', 'SIGHUP']

export async function privateTempDir(dir: string): Promise<string | null> {
  if (WINDOWS) return null
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stats = await lstat(dir)
  if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o022) !== 0) {
    throw new Error(
      `Refusing ${dir}: it must be a directory that only the current user can write to`
    )
  }
  return dir
}

export function runBinary(
  file: string,
  args: string[],
  tempDir: string | null = null
): Promise<number> {
  return new Promise((resolve, reject) => {
    const env = tempDir ? { ...process.env, TMPDIR: tempDir } : process.env
    const child = spawn(file, args, { stdio: 'inherit', env })
    // On Windows the console already sends Ctrl-C to the child, and kill() would terminate it.
    const forward = (signal: NodeJS.Signals): void => {
      if (!WINDOWS) child.kill(signal)
    }
    const stopForwarding = (): void => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward)
    }
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward)

    child.on('error', (error) => {
      stopForwarding()
      reject(error)
    })
    child.on('exit', (code, signal) => {
      stopForwarding()
      resolve(code ?? (signal ? 128 + constants.signals[signal] : 1))
    })
  })
}
