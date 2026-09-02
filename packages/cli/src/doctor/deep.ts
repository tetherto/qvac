import { fork, spawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveSdkEntrypoint } from '@/doctor/checks/project'
import {
  isDeepProbeMessage,
  isDeepProbeProtocolCandidate,
  type DeepProbeMessage,
  type DeepProbePhase,
  type SerializedProbeError
} from '@/doctor/deep-protocol'
import type { CheckResult, CheckSection } from '@/doctor/types'

const DEFAULT_TIMEOUT_MS = 45_000
const MAX_OUTPUT_CHARS = 16_384
const TERMINATION_GRACE_MS = 2_000

export interface SdkRuntimeProbeResult {
  outcome: 'pass' | 'fail' | 'timeout' | 'spawn-error' | 'protocol-error'
  durationMs: number
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  phase?: DeepProbePhase | undefined
  probeMessage?: DeepProbeMessage | undefined
  error?: string | undefined
}

export interface SdkRuntimeProbeOptions {
  timeoutMs?: number | undefined
  maxOutputChars?: number | undefined
  nodePath?: string | undefined
  childModulePath?: string | undefined
}

export type SdkRuntimeFailureId =
  | 'cpu-instruction'
  | 'libstdcxx'
  | 'visual-cpp-runtime'
  | 'vulkan'
  | 'shared-library'
  | 'bare-runtime'
  | 'worker-handshake-timeout'
  | 'spawn-error'
  | 'protocol-error'
  | 'import-failed'
  | 'cleanup-failed'
  | 'heartbeat-failed'

export interface SdkRuntimeFailureClassification {
  id: SdkRuntimeFailureId
  hint: string
}

interface FailureRule extends SdkRuntimeFailureClassification {
  matches: (result: SdkRuntimeProbeResult, diagnostics: string) => boolean
}

function appendBounded(current: string, chunk: string, limit: number): string {
  const next = current + chunk
  return next.length <= limit ? next : next.slice(next.length - limit)
}

function defaultChildModulePath(): string {
  const compiledPath = fileURLToPath(new URL('./deep-probe-child.js', import.meta.url))
  if (fs.existsSync(compiledPath)) return compiledPath
  return fileURLToPath(new URL('./deep-probe-child.ts', import.meta.url))
}

function spawnErrorResult(startedAt: number, error: unknown): SdkRuntimeProbeResult {
  return {
    outcome: 'spawn-error',
    durationMs: Date.now() - startedAt,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    error: error instanceof Error ? error.message : String(error)
  }
}

function signalProbeTree(child: ReturnType<typeof fork>, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return

  if (process.platform === 'win32') {
    const killChildIfRunning = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    }
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.once('error', killChildIfRunning)
    killer.once('close', (exitCode) => {
      if (exitCode !== 0) killChildIfRunning()
    })
    return
  }

  try {
    process.kill(-pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') child.kill(signal)
  }
}

export function probeSdkRuntime(
  entrypoint: string,
  projectRoot: string,
  options: SdkRuntimeProbeOptions = {}
): Promise<SdkRuntimeProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS
  const startedAt = Date.now()
  let child: ReturnType<typeof fork>
  try {
    child = fork(
      options.childModulePath ?? defaultChildModulePath(),
      [pathToFileURL(entrypoint).href],
      {
        cwd: projectRoot,
        detached: process.platform !== 'win32',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        execPath: options.nodePath ?? process.execPath,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      }
    )
  } catch (error) {
    return Promise.resolve(spawnErrorResult(startedAt, error))
  }

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let spawnError: string | undefined
  let protocolMessage: DeepProbeMessage | undefined
  let protocolCandidateCount = 0
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk.toString('utf8'), maxOutputChars)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk.toString('utf8'), maxOutputChars)
  })
  child.on('message', (message: unknown) => {
    if (!isDeepProbeProtocolCandidate(message)) return
    protocolCandidateCount += 1
    if (isDeepProbeMessage(message) && protocolMessage === undefined) protocolMessage = message
  })

  return new Promise((resolve) => {
    let terminationTimer: NodeJS.Timeout | undefined
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      signalProbeTree(child, 'SIGTERM')
      terminationTimer = setTimeout(() => signalProbeTree(child, 'SIGKILL'), TERMINATION_GRACE_MS)
      terminationTimer.unref()
    }, timeoutMs)
    timeoutTimer.unref()

    child.once('error', (error) => {
      spawnError = error.message
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeoutTimer)
      if (terminationTimer !== undefined) clearTimeout(terminationTimer)
      // A failed Unix probe may have spawned descendants even when it did not
      // time out. Its process group remains addressable after the leader exits.
      // Windows has no equivalent group handle here, and reusing the exited
      // leader's PID with taskkill could target an unrelated process tree.
      if (process.platform !== 'win32' && (timedOut || exitCode !== 0 || signal !== null)) {
        signalProbeTree(child, 'SIGKILL')
      }

      let outcome: SdkRuntimeProbeResult['outcome']
      let error = spawnError
      if (spawnError !== undefined) {
        outcome = 'spawn-error'
      } else if (timedOut) {
        outcome = 'timeout'
      } else if (protocolCandidateCount !== 1 || protocolMessage === undefined) {
        outcome = 'protocol-error'
        error =
          protocolCandidateCount === 0
            ? 'Probe exited without a result message.'
            : 'Probe emitted an invalid or duplicate result message.'
      } else if (protocolMessage.ok && exitCode === 0) {
        outcome = 'pass'
      } else if (!protocolMessage.ok && exitCode !== 0) {
        outcome = 'fail'
      } else {
        outcome = 'protocol-error'
        error = 'Probe result message did not agree with its exit code.'
      }

      resolve({
        outcome,
        durationMs: Date.now() - startedAt,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        signal,
        ...(protocolMessage !== undefined
          ? { phase: protocolMessage.phase, probeMessage: protocolMessage }
          : {}),
        ...(error !== undefined ? { error } : {})
      })
    })
  })
}

function formatSerializedError(error: SerializedProbeError, label: string): string {
  const attributes = [
    error.code !== undefined ? `code=${String(error.code)}` : '',
    error.exitCode !== undefined ? `exitCode=${String(error.exitCode)}` : '',
    error.exitSignal !== undefined ? `exitSignal=${String(error.exitSignal)}` : ''
  ].filter(Boolean)
  const heading = attributes.length > 0 ? `${label} (${attributes.join(', ')}):` : `${label}:`
  const current = `${heading}\n${error.stack ?? `${error.name}: ${error.message}`}`
  return error.cause === undefined
    ? current
    : `${current}\n${formatSerializedError(error.cause, 'Caused by')}`
}

function formatDiagnostics(result: SdkRuntimeProbeResult): string | undefined {
  const failure = result.probeMessage?.ok === false ? result.probeMessage : undefined
  const parts = [
    result.error ? `Probe error:\n${result.error}` : '',
    failure ? formatSerializedError(failure.error, `Failure during ${failure.phase}`) : '',
    failure?.cleanupError ? formatSerializedError(failure.cleanupError, 'Cleanup failure') : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
    result.stdout ? `stdout:\n${result.stdout}` : ''
  ].filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function diagnosticText(result: SdkRuntimeProbeResult): string {
  return formatDiagnostics(result) ?? ''
}

const FAILURE_RULES: readonly FailureRule[] = [
  {
    id: 'cpu-instruction',
    matches: (result, diagnostics) =>
      result.signal === 'SIGILL' ||
      /exitSignal=SIGILL|signal SIGILL|illegal instruction|\bSIGILL\b/i.test(diagnostics),
    hint: 'A native addon used an instruction unsupported by this CPU. Use a compatible addon build or a worker bundle that excludes the affected plugin.'
  },
  {
    id: 'libstdcxx',
    matches: (_result, diagnostics) =>
      /GLIBCXX_[\d.]+.*not found|version [`\'"]GLIBCXX_/i.test(diagnostics),
    hint: 'The host libstdc++ may be missing or older than a native addon requires. Install or update libstdc++, or use an addon build compatible with this distribution.'
  },
  {
    id: 'visual-cpp-runtime',
    matches: (_result, diagnostics) =>
      /VCRUNTIME\d*\.dll|MSVCP\d*\.dll|Visual C\+\+.*Redistributable/i.test(diagnostics),
    hint: 'A Microsoft Visual C++ runtime dependency may be missing. Install the current Visual C++ Redistributable and retry.'
  },
  {
    id: 'vulkan',
    matches: (_result, diagnostics) =>
      /VK_ERROR_|vkCreateInstance|vkEnumerateInstance|(?:lib)?vulkan[^\n]*(failed|error|not found|unsupported|version|cannot open)/i.test(
        diagnostics
      ),
    hint: 'A Vulkan dependency may have failed to load or initialize. Install or update the Vulkan loader and GPU driver to versions providing Vulkan 1.4 or newer.'
  },
  {
    id: 'shared-library',
    matches: (_result, diagnostics) =>
      /error while loading shared libraries|cannot open shared object file|Library not loaded|The specified module could not be found/i.test(
        diagnostics
      ),
    hint: 'A native shared-library dependency may not have loaded. Re-run with --verbose to identify the missing or incompatible library.'
  },
  {
    id: 'bare-runtime',
    matches: (_result, diagnostics) =>
      /BARE_RUNTIME_BINARY_NOT_FOUND|BareRuntimeBinaryNotFoundError|Bare runtime binary.*not found/i.test(
        diagnostics
      ),
    hint: 'The Bare runtime binary appears to be missing. Reinstall @qvac/sdk with lifecycle scripts enabled for this host.'
  },
  {
    id: 'worker-handshake-timeout',
    matches: (result, diagnostics) =>
      result.outcome === 'timeout' ||
      /RPC_INIT_TIMEOUT|RPCInitTimeoutError|RPC initialization timed out/i.test(diagnostics),
    hint: 'The SDK worker did not complete its startup handshake. Re-run with --verbose to inspect the bounded worker output.'
  },
  {
    id: 'spawn-error',
    matches: (result) => result.outcome === 'spawn-error',
    hint: 'The isolated Node.js probe could not be started. Re-run with --verbose for the operating-system error.'
  },
  {
    id: 'protocol-error',
    matches: (result) => result.outcome === 'protocol-error',
    hint: 'The isolated probe exited without a valid result. Re-run with --verbose to inspect its bounded output.'
  },
  {
    id: 'import-failed',
    matches: (result) => result.phase === 'import',
    hint: 'The installed @qvac/sdk could not be imported or initialized. Re-run with --verbose to inspect the error.'
  },
  {
    id: 'cleanup-failed',
    matches: (result) => result.phase === 'close',
    hint: 'The SDK worker responded, but its cleanup failed. Re-run with --verbose to inspect the cleanup error.'
  }
]

const DEFAULT_FAILURE_RULE: SdkRuntimeFailureClassification = {
  id: 'heartbeat-failed',
  hint: 'The SDK worker failed its heartbeat. Re-run with --verbose to inspect the bounded worker output.'
}

const WINDOWS_WORKER_WARNING =
  'On Windows, a Bare worker process may still be running after a failed deep check; terminate it manually if needed.'

export function classifySdkRuntimeFailure(
  result: SdkRuntimeProbeResult,
  platform: NodeJS.Platform = process.platform
): SdkRuntimeFailureClassification {
  const diagnostics = diagnosticText(result)
  const rule = FAILURE_RULES.find((candidate) => candidate.matches(result, diagnostics))
  const classification = rule ?? DEFAULT_FAILURE_RULE
  const warnAboutWindowsWorker = platform === 'win32' && result.outcome !== 'spawn-error'
  return {
    id: classification.id,
    hint: warnAboutWindowsWorker
      ? `${classification.hint} ${WINDOWS_WORKER_WARNING}`
      : classification.hint
  }
}

function formatFailureValue(result: SdkRuntimeProbeResult): string {
  if (result.outcome === 'timeout') return `timed out after ${result.durationMs} ms`
  if (result.signal !== null) return `terminated by ${result.signal}`
  if (result.outcome === 'spawn-error') return 'probe could not start'
  if (result.outcome === 'protocol-error') return 'invalid probe result'
  if (result.phase !== undefined) return `${result.phase} failed`
  return `exited with code ${result.exitCode ?? 'unknown'}`
}

export async function checkSdkRuntime(projectRoot: string): Promise<CheckResult> {
  let entrypoint: string
  try {
    entrypoint = resolveSdkEntrypoint(projectRoot)
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    return {
      id: 'sdk-runtime',
      label: '@qvac/sdk worker heartbeat',
      status: 'fail',
      severity: 'required',
      code: 'sdk-not-found',
      value: 'SDK entrypoint not found',
      hint: 'Install @qvac/sdk in this project, or repair the installation, before running --deep.',
      detail: `SDK resolution error:\n${detail}`
    }
  }

  const result = await probeSdkRuntime(entrypoint, projectRoot)
  if (result.outcome === 'pass') {
    return {
      id: 'sdk-runtime',
      label: '@qvac/sdk worker heartbeat',
      status: 'pass',
      severity: 'required',
      value: `${result.durationMs} ms`
    }
  }

  const detail = formatDiagnostics(result)
  const classification = classifySdkRuntimeFailure(result)
  return {
    id: 'sdk-runtime',
    label: '@qvac/sdk worker heartbeat',
    status: 'fail',
    severity: 'required',
    code: classification.id,
    value: formatFailureValue(result),
    hint: classification.hint,
    ...(detail !== undefined ? { detail } : {})
  }
}

export async function collectDeepCheckSection(projectRoot: string): Promise<CheckSection> {
  return {
    id: 'deep',
    title: 'SDK runtime (deep)',
    checks: [await checkSdkRuntime(projectRoot)]
  }
}
