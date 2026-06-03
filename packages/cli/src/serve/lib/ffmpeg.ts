import { spawn } from 'node:child_process'

export interface FfmpegRunOptions {
  /** Path or basename of the ffmpeg binary. Defaults to `ffmpeg` (resolved via PATH). */
  ffmpegPath?: string
  /** Wall-clock cap on the ffmpeg process (ms). Default 5 minutes. */
  timeoutMs?: number
  /** Cap on captured stderr bytes (used in error messages). Default 8 KiB. */
  maxStderrBytes?: number
}

export class FfmpegFailedError extends Error {
  readonly stderr: string
  readonly exitCode: number | null
  constructor (message: string, stderr: string, exitCode: number | null) {
    super(message)
    this.name = 'FfmpegFailedError'
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

export class FfmpegTimeoutError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'FfmpegTimeoutError'
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024

/**
 * Runs ffmpeg with the given args, feeding `input` to stdin and returning
 * stdout as a Buffer. stderr is captured up to a byte cap and surfaced in any
 * thrown error. Times out after `timeoutMs` (default 5 min).
 */
export async function runFfmpeg (
  args: string[],
  input: Buffer,
  opts: FfmpegRunOptions = {}
): Promise<Buffer> {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxStderrBytes = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stderrLen = 0
    let settled = false

    function settle (fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* noop */ }
      settle(() => reject(new FfmpegTimeoutError(`ffmpeg timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrLen >= maxStderrBytes) return
      const remaining = maxStderrBytes - stderrLen
      stderrChunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      stderrLen += Math.min(chunk.length, remaining)
    })

    child.on('error', (err) => {
      settle(() => reject(new FfmpegFailedError(
        `ffmpeg failed to start: ${err.message}`,
        Buffer.concat(stderrChunks).toString('utf8'),
        null
      )))
    })

    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (code === 0) {
        settle(() => resolve(Buffer.concat(stdoutChunks)))
        return
      }
      settle(() => reject(new FfmpegFailedError(
        `ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
        stderr,
        code ?? null
      )))
    })

    // ffmpeg may close stdin early; the close handler reports the real cause.
    child.stdin.on('error', () => { /* noop */ })
    child.stdin.end(input)
  })
}

/**
 * Runs `ffmpeg -version` once to verify ffmpeg is on PATH. Intended to be
 * cached at server start and not re-probed.
 */
export async function probeFfmpegAvailable (ffmpegPath: string = 'ffmpeg'): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let resolved = false
    function done (ok: boolean): void {
      if (resolved) return
      resolved = true
      resolve(ok)
    }
    try {
      const child = spawn(ffmpegPath, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] })
      child.on('error', () => done(false))
      child.on('close', (code) => done(code === 0))
    } catch {
      done(false)
    }
  })
}
