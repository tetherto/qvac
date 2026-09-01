// Forked by `doctor/deep.ts` with `cwd` set to the probed project. No tsconfig
// is discoverable from there, so imports in this module are relative.
import {
  DEEP_PROBE_MESSAGE_KIND,
  DEEP_PROBE_PROTOCOL_VERSION,
  type DeepProbeFailureMessage,
  type DeepProbeMessage,
  type DeepProbePhase,
  type SerializedProbeError
} from './deep-protocol.js'

const ERROR_MESSAGE_CHARS = 2_048
const ERROR_STACK_CHARS = 8_192
const MAX_CAUSE_DEPTH = 5
const CLEANUP_TIMEOUT_MS = 2_000

interface SdkProbeApi {
  heartbeat: () => Promise<unknown>
  close: () => Promise<void>
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`
}

function serializeError(error: unknown, depth: number = 0): SerializedProbeError {
  if (!(error instanceof Error)) {
    return { name: 'NonErrorThrown', message: clip(String(error), ERROR_MESSAGE_CHARS) }
  }

  const extended = error as Error & {
    code?: unknown
    exitCode?: unknown
    exitSignal?: unknown
  }
  const result: SerializedProbeError = {
    name: error.name,
    message: clip(error.message, ERROR_MESSAGE_CHARS)
  }
  if (error.stack) result.stack = clip(error.stack, ERROR_STACK_CHARS)
  if (typeof extended.code === 'string' || typeof extended.code === 'number') {
    result.code = extended.code
  }
  if (typeof extended.exitCode === 'number' || extended.exitCode === null) {
    result.exitCode = extended.exitCode
  }
  if (typeof extended.exitSignal === 'string' || extended.exitSignal === null) {
    result.exitSignal = extended.exitSignal
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    result.cause = serializeError(error.cause, depth + 1)
  }
  return result
}

function sendResult(message: DeepProbeMessage): Promise<void> {
  return new Promise((resolve) => {
    if (typeof process.send !== 'function') {
      process.stderr.write('QVAC doctor probe was started without an IPC channel.\n')
      resolve()
      return
    }
    process.send(message, () => resolve())
  })
}

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  if (!stream.writable) return Promise.resolve()
  return new Promise((resolve) => stream.write('', () => resolve()))
}

async function finish(message: DeepProbeMessage, exitCode: number): Promise<never> {
  await sendResult(message)
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
  process.exit(exitCode)
}

async function closeWithTimeout(
  close: () => Promise<void>
): Promise<SerializedProbeError | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`SDK cleanup timed out after ${CLEANUP_TIMEOUT_MS} ms.`)
          error.name = 'CleanupTimeoutError'
          reject(error)
        }, CLEANUP_TIMEOUT_MS)
      })
    ])
    return undefined
  } catch (error) {
    return serializeError(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function run(): Promise<void> {
  const entrypoint = process.argv[2]
  let phase: DeepProbePhase = 'import'
  let sdk: SdkProbeApi | undefined

  try {
    if (!entrypoint) throw new Error('Missing @qvac/sdk entrypoint argument.')
    const imported = (await import(entrypoint)) as Partial<SdkProbeApi>
    if (typeof imported.heartbeat !== 'function' || typeof imported.close !== 'function') {
      throw new Error('The installed @qvac/sdk does not export heartbeat() and close().')
    }
    sdk = { heartbeat: imported.heartbeat, close: imported.close }

    phase = 'heartbeat'
    await sdk.heartbeat()

    phase = 'close'
    const closeError = await closeWithTimeout(sdk.close)
    if (closeError !== undefined) {
      await finish(
        {
          kind: DEEP_PROBE_MESSAGE_KIND,
          version: DEEP_PROBE_PROTOCOL_VERSION,
          ok: false,
          phase,
          error: closeError
        },
        1
      )
    }

    await finish(
      {
        kind: DEEP_PROBE_MESSAGE_KIND,
        version: DEEP_PROBE_PROTOCOL_VERSION,
        ok: true,
        phase
      },
      0
    )
  } catch (error) {
    const failure: DeepProbeFailureMessage = {
      kind: DEEP_PROBE_MESSAGE_KIND,
      version: DEEP_PROBE_PROTOCOL_VERSION,
      ok: false,
      phase,
      error: serializeError(error)
    }
    if (phase !== 'close' && sdk !== undefined) {
      const cleanupError = await closeWithTimeout(sdk.close)
      if (cleanupError !== undefined) failure.cleanupError = cleanupError
    }
    await finish(failure, 1)
  }
}

await run()
