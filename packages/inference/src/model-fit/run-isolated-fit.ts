import {
  encodeFitLlamaProcessRequest,
  FIT_PROCESS_MAX_RESPONSE_BYTES,
  parseFitProcessResponse,
  resolveFitProcessRunnerPath,
  type FitLlamaProcessConfig,
  type FitLlamaResult,
  type LlamaLoadKind
} from '@qvac/model-fit/process'
import type { AbortSignal } from 'bare-abort-controller'
import env from 'bare-env'
import spawnBare from 'bare-runtime/spawn'
import { arch, isAndroid, isBrowser, isIOS, platform } from 'which-runtime'

const DEFAULT_TIMEOUT_MS = 60_000
const TERMINATION_GRACE_MS = 1_000
const FINAL_KILL_GRACE_MS = 1_000
const DRAIN_GRACE_MS = 1_000
const STDERR_TAIL_BYTES = 16 * 1024

const FIT_ENVIRONMENT_KEYS = [
  'HOME',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'VK_ICD_FILENAMES',
  'VK_DRIVER_FILES',
  'CUDA_VISIBLE_DEVICES',
  'HIP_VISIBLE_DEVICES',
  'ROCR_VISIBLE_DEVICES'
] as const

export type IsolatedFitUnknownReason =
  | 'unsupported-platform'
  | 'spawn-failed'
  | 'timeout'
  | 'cancelled'
  | 'crashed'
  | 'invalid-response'
  | 'invocation-error'

export type IsolatedFitResult =
  | { status: 'completed'; result: FitLlamaResult }
  | {
      status: 'unknown'
      reason: IsolatedFitUnknownReason
      message: string
      stderrTail?: string
    }

export interface SpawnContext {
  command: string
  options: {
    args: string[]
    platform: string
    arch: string
    stdio: string[]
    env: Record<string, string>
  }
}

export interface RuntimeContext {
  platform: string
  arch: string
  isAndroid: boolean
  isBrowser: boolean
  isIOS: boolean
}

export interface RunIsolatedFitOptions {
  timeoutMs?: number
  signal?: AbortSignal
  spawnProcess?: (context: SpawnContext) => ChildProcess
  runtime?: RuntimeContext
  environment?: Record<string, string | undefined>
  runnerPath?: string
  runnerArgs?: string[]
  terminationGraceMs?: number
  finalKillGraceMs?: number
  drainGraceMs?: number
}

interface PendingTermination {
  reason: IsolatedFitUnknownReason
  message: string
  crashCanOverride: boolean
}

export interface ErrorEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
}

export interface ReadableChildStream {
  setEncoding(encoding: 'utf8'): void
  destroy(): void
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'data', listener: (chunk: string) => void): unknown
}

export interface WritableChildStream {
  end(data?: string): void
  destroy(): void
  on(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
}

export interface ChildProcess {
  stdin: WritableChildStream | null
  stdout: ReadableChildStream | null
  stderr: ReadableChildStream | null
  kill(signal?: string): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: string | number | null) => void
  ): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  off(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: string | number | null) => void
  ): unknown
}

function ignoreLateError(): void {}

function allowedEnvironment(
  environment: Record<string, string | undefined>
): Record<string, string> {
  const allowed: Record<string, string> = {}
  for (const key of FIT_ENVIRONMENT_KEYS) {
    const value = environment[key]
    if (value !== undefined) allowed[key] = value
  }
  return allowed
}

// Local bare-buffer typings vary on the instance surface; the runtime value
// is always a real Buffer, so intersect with Uint8Array for length/subarray.
type TailBytes = Buffer & Uint8Array

function appendTail(current: TailBytes, chunk: string): TailBytes {
  const combined = Buffer.concat([current, Buffer.from(chunk)]) as TailBytes
  return combined.length <= STDERR_TAIL_BYTES
    ? combined
    : (combined.subarray(combined.length - STDERR_TAIL_BYTES) as TailBytes)
}

function unknown(
  reason: IsolatedFitUnknownReason,
  message: string,
  stderrTail: TailBytes
): IsolatedFitResult {
  return stderrTail.length === 0
    ? { status: 'unknown', reason, message }
    : { status: 'unknown', reason, message, stderrTail: stderrTail.toString() }
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function normalizeExitSignal(signal: string | number | null): string | null {
  return signal === null || signal === 0 ? null : String(signal)
}

function parseResponse(line: string, stderrTail: Buffer): IsolatedFitResult {
  try {
    const response = parseFitProcessResponse(JSON.parse(line))
    if (response.status === 'invocation-error') {
      return unknown(
        'invocation-error',
        `${response.error.name}: ${response.error.message}`,
        stderrTail
      )
    }
    return { status: 'completed', result: response.result }
  } catch (error) {
    return unknown('invalid-response', formatError(error), stderrTail)
  }
}

export function runIsolatedFit(
  loadKind: LlamaLoadKind,
  config: FitLlamaProcessConfig,
  options: RunIsolatedFitOptions = {}
): Promise<IsolatedFitResult> {
  const runtime = options.runtime ?? {
    platform,
    arch,
    isAndroid,
    isBrowser,
    isIOS
  }
  if (runtime.isAndroid || runtime.isBrowser || runtime.isIOS) {
    return Promise.resolve({
      status: 'unknown',
      reason: 'unsupported-platform',
      message: `Fit subprocess isolation is unavailable on ${runtime.platform}`
    })
  }

  const spawnProcess =
    options.spawnProcess ??
    ((context: SpawnContext) =>
      spawnBare(context.command, context.options) as unknown as ChildProcess)
  const environment = options.environment ?? env
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const terminationGraceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS
  const finalKillGraceMs = options.finalKillGraceMs ?? FINAL_KILL_GRACE_MS
  const drainGraceMs = options.drainGraceMs ?? DRAIN_GRACE_MS

  return new Promise((resolve) => {
    let child: ChildProcess | undefined
    const streams: {
      stdin: WritableChildStream | undefined
      stdout: ReadableChildStream | undefined
      stderr: ReadableChildStream | undefined
    } = {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined
    }
    const timers: {
      timeout: ReturnType<typeof setTimeout> | undefined
      forceKill: ReturnType<typeof setTimeout> | undefined
      finalKill: ReturnType<typeof setTimeout> | undefined
      drain: ReturnType<typeof setTimeout> | undefined
    } = {
      timeout: undefined,
      forceKill: undefined,
      finalKill: undefined,
      drain: undefined
    }
    let settled = false
    let destroyingStreams = false
    let stdout = ''
    let stdoutFailure: string | undefined
    let stderrTail: TailBytes = Buffer.alloc(0) as TailBytes
    let pendingTermination: PendingTermination | undefined
    let exitStatus: { code: number | null; signal: string | null } | undefined

    function safely(action: () => void): void {
      try {
        action()
      } catch {}
    }

    // A destroyed pipe or a reaped child can still emit EPIPE/ERR_STREAM_DESTROYED
    // after the promise settles; without a listener that would take down the host,
    // so the active handler is swapped for an inert one instead of removed.
    function silenceErrors(
      emitter: ErrorEmitter | undefined,
      active: (error: Error) => void
    ): void {
      if (emitter === undefined) return
      safely(() => emitter.on('error', ignoreLateError))
      safely(() => emitter.off('error', active))
    }

    function cleanup(): void {
      if (timers.timeout !== undefined) clearTimeout(timers.timeout)
      if (timers.forceKill !== undefined) clearTimeout(timers.forceKill)
      if (timers.finalKill !== undefined) clearTimeout(timers.finalKill)
      if (timers.drain !== undefined) clearTimeout(timers.drain)
      options.signal?.removeEventListener('abort', onAbort)
      safely(() => child?.off('exit', onExit))
      safely(() => child?.off('close', onClose))
      safely(() => streams.stdout?.off('data', onStdoutData))
      safely(() => streams.stderr?.off('data', onStderrData))
      silenceErrors(child, onChildError)
      silenceErrors(streams.stdin, onStdinError)
      silenceErrors(streams.stdout, onStdoutError)
      silenceErrors(streams.stderr, onStderrError)
    }

    function settle(result: IsolatedFitResult): void {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    function kill(signal: string): void {
      safely(() => {
        child?.kill(signal)
      })
    }

    function requestTermination(
      reason: IsolatedFitUnknownReason,
      message: string,
      crashCanOverride = false
    ): void {
      if (settled || exitStatus !== undefined || pendingTermination !== undefined) return
      pendingTermination = { reason, message, crashCanOverride }
      timers.forceKill = setTimeout(() => {
        if (settled || exitStatus !== undefined) return
        kill('SIGKILL')
        if (exitStatus !== undefined) return
        timers.finalKill = setTimeout(() => {
          if (settled || exitStatus !== undefined || pendingTermination === undefined) return
          // Bound liveness when the child cannot be observed as reaped after SIGKILL.
          destroyLocalStreams()
          settle(
            unknown(
              pendingTermination.reason,
              `${pendingTermination.message}; child did not report exit`,
              stderrTail
            )
          )
        }, finalKillGraceMs)
      }, terminationGraceMs)
      kill('SIGTERM')
    }

    function destroyLocalStreams(): void {
      destroyingStreams = true
      safely(() => streams.stdin?.destroy())
      safely(() => streams.stdout?.destroy())
      safely(() => streams.stderr?.destroy())
    }

    function finalize(code: number | null, signal: string | null): void {
      const newlineIndex = stdout.indexOf('\n')
      const hasTrailingTerminator = newlineIndex === stdout.length - 1
      const invalidFraming = newlineIndex !== -1 && !hasTrailingTerminator
      const line = hasTrailingTerminator ? stdout.slice(0, -1) : stdout
      const response =
        stdoutFailure === undefined && !invalidFraming && line !== ''
          ? parseResponse(line, stderrTail)
          : undefined

      if (pendingTermination !== undefined && pendingTermination.crashCanOverride === false) {
        settle(unknown(pendingTermination.reason, pendingTermination.message, stderrTail))
        return
      }

      // A signalled death outranks the runner's own diagnosis: the response was
      // written before whatever killed the child, so it cannot describe the exit.
      if (
        signal === null &&
        response?.status === 'unknown' &&
        response.reason === 'invocation-error'
      ) {
        settle(response)
        return
      }

      if (code !== 0 || signal !== null) {
        settle(
          unknown(
            'crashed',
            `Fit subprocess exited with code ${String(code)} and signal ${String(signal)}`,
            stderrTail
          )
        )
        return
      }

      if (pendingTermination !== undefined) {
        settle(unknown(pendingTermination.reason, pendingTermination.message, stderrTail))
        return
      }

      if (stdoutFailure !== undefined) {
        settle(unknown('invalid-response', stdoutFailure, stderrTail))
        return
      }

      if (invalidFraming || line === '') {
        settle(
          unknown(
            'invalid-response',
            invalidFraming
              ? 'Fit subprocess returned invalid line framing'
              : `Fit subprocess exited with code ${String(code)} and signal ${String(signal)}`,
            stderrTail
          )
        )
        return
      }

      settle(response ?? parseResponse(line, stderrTail))
    }

    function onAbort(): void {
      requestTermination('cancelled', 'Fit subprocess was cancelled')
    }

    function onChildError(error: Error): void {
      requestTermination('spawn-failed', formatError(error))
    }

    function onExit(code: number | null, rawSignal: string | number | null): void {
      if (exitStatus !== undefined) return
      const signal = normalizeExitSignal(rawSignal)
      exitStatus = { code, signal }
      if (timers.timeout !== undefined) {
        clearTimeout(timers.timeout)
        timers.timeout = undefined
      }
      if (timers.forceKill !== undefined) {
        clearTimeout(timers.forceKill)
        timers.forceKill = undefined
      }
      if (timers.finalKill !== undefined) {
        clearTimeout(timers.finalKill)
        timers.finalKill = undefined
      }
      timers.drain = setTimeout(() => {
        destroyLocalStreams()
        finalize(code, signal)
      }, drainGraceMs)
    }

    function onClose(code: number | null, rawSignal: string | number | null): void {
      const status = exitStatus ?? { code, signal: normalizeExitSignal(rawSignal) }
      finalize(status.code, status.signal)
    }

    function onStdoutData(chunk: string): void {
      if (settled || pendingTermination !== undefined || destroyingStreams) {
        return
      }

      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > FIT_PROCESS_MAX_RESPONSE_BYTES) {
        if (exitStatus !== undefined) {
          stdoutFailure = 'Fit subprocess response exceeds 1 MiB'
          return
        }
        requestTermination('invalid-response', 'Fit subprocess response exceeds 1 MiB')
        return
      }
      stdout += chunk
      const newlineIndex = stdout.indexOf('\n')
      if (newlineIndex !== -1 && newlineIndex !== stdout.length - 1) {
        if (exitStatus !== undefined) {
          stdoutFailure = 'Fit subprocess returned invalid line framing'
        } else {
          requestTermination('invalid-response', 'Fit subprocess returned invalid line framing')
        }
      }
    }

    function onStderrData(chunk: string): void {
      if (settled || destroyingStreams) return
      stderrTail = appendTail(stderrTail, chunk)
    }

    function onStdinError(error: Error): void {
      if (destroyingStreams) return
      requestTermination('invalid-response', `Fit subprocess stdin failed: ${error.message}`, true)
    }

    function onStdoutError(error: Error): void {
      if (destroyingStreams) return
      requestTermination('invalid-response', `Fit subprocess stdout failed: ${error.message}`)
    }

    function onStderrError(error: Error): void {
      if (destroyingStreams) return
      requestTermination('invalid-response', `Fit subprocess stderr failed: ${error.message}`)
    }

    try {
      const stdio: string[] =
        runtime.platform === 'win32'
          ? ['overlapped', 'overlapped', 'overlapped']
          : ['pipe', 'pipe', 'pipe']
      child = spawnProcess({
        command: 'bare',
        options: {
          args: [
            options.runnerPath ?? resolveFitProcessRunnerPath(),
            ...(options.runnerArgs ?? [])
          ],
          platform: runtime.platform,
          arch: runtime.arch,
          stdio,
          env: allowedEnvironment(environment)
        }
      })
    } catch (error) {
      settle(unknown('spawn-failed', formatError(error), stderrTail))
      return
    }

    child.on('error', onChildError)
    child.on('exit', onExit)
    child.on('close', onClose)

    const stdin = child.stdin
    const stdoutStream = child.stdout
    const stderrStream = child.stderr
    streams.stdin = stdin ?? undefined
    streams.stdout = stdoutStream ?? undefined
    streams.stderr = stderrStream ?? undefined

    options.signal?.addEventListener('abort', onAbort, { once: true })
    timers.timeout = setTimeout(() => {
      requestTermination('timeout', `Fit subprocess exceeded ${timeoutMs}ms`)
    }, timeoutMs)

    try {
      streams.stdin?.on('error', onStdinError)
      streams.stdout?.on('data', onStdoutData)
      streams.stdout?.on('error', onStdoutError)
      streams.stderr?.on('data', onStderrData)
      streams.stderr?.on('error', onStderrError)
    } catch (error) {
      requestTermination(
        'invalid-response',
        `Fit subprocess stream setup failed: ${formatError(error)}`
      )
      destroyLocalStreams()
      return
    }

    if (stdin === null || stdoutStream === null || stderrStream === null) {
      requestTermination('spawn-failed', 'Fit subprocess stdio pipes are unavailable')
      destroyLocalStreams()
      return
    }

    try {
      stdoutStream.setEncoding('utf8')
      stderrStream.setEncoding('utf8')
    } catch (error) {
      requestTermination(
        'invalid-response',
        `Fit subprocess stream setup failed: ${formatError(error)}`
      )
      destroyLocalStreams()
      return
    }

    if (options.signal?.aborted === true) {
      onAbort()
      return
    }

    try {
      stdin.end(encodeFitLlamaProcessRequest(loadKind, config))
    } catch (error) {
      requestTermination(
        'invalid-response',
        `Fit subprocess request write failed: ${formatError(error)}`
      )
      destroyLocalStreams()
    }
  })
}
