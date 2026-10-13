import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { TestExecutor, TestResult } from './consumer-base.js'
import type { TestDefinition } from '../types/test-definition.js'

/**
 * Drives a non-JS client over stdin/stdout so the MQTT state machine stays implemented once, in
 * Node. Newline-delimited JSON, one request in flight.
 *
 *   client    -> framework  { "type": "ready", "protocol": 1 }
 *   framework -> client     { "type": "execute", "id", "testId", "params", "expectation",
 *                             "metadata", "steps", "finally"? }
 *   client    -> framework  { "type": "log", "message" }                      (zero or more)
 *   client    -> framework  { "type": "result", "id", "passed", "output",
 *                             "skipped"?, "incomplete"?, "reason"?, "assertedValue"? }
 *   framework -> client     { "type": "shutdown" }
 *
 * A `result` MUST echo the `id` it answers. Without it a late reply to a test that already timed
 * out settles the next one, and the run reports one test's result under another's name.
 */

export interface BridgeExecutorOptions {
  interpreter: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  testDefinitions: TestDefinition[]
  log: (message: string) => void
  /** How long to wait for the client's `ready` handshake. */
  readyTimeoutMs?: number
  /**
   * Directory to resolve the Bare runtime from, so the client is handed the same binary the JS legs
   * use. Usually the config directory.
   */
  resolveBareFrom?: string
}

interface BridgeResult {
  type: 'result'
  id?: number
  passed?: boolean
  output?: string
  skipped?: boolean
  incomplete?: boolean
  reason?: string
  assertedValue?: unknown
}

const DEFAULT_READY_TIMEOUT_MS = 60_000

/** How long the client is given to exit on its own before SIGTERM. */
const SHUTDOWN_GRACE_MS = 5_000

/**
 * Ceiling on one unterminated protocol line. Generous: an `assertedValue` is summarised before it
 * is sent, so anything near this has stopped speaking the protocol.
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024

/**
 * The parent environment, minus the broker credentials: the framework owns MQTT on this client's
 * behalf, so the client has no use for them. The rest it genuinely needs -- PATH, HOME, and
 * whatever its runtime reads.
 */
function clientEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MQTT_')))
}

/** Make the resolved Bare binary executable, the way `bare-runtime` does. */
function ensureExecutable(binary: string): void {
  try {
    fs.accessSync(binary, fs.constants.X_OK)
  } catch {
    fs.chmodSync(binary, 0o755)
  }
}

export class BridgeExecutor implements TestExecutor {
  private child?: ChildProcessWithoutNullStreams
  private readonly options: BridgeExecutorOptions
  private readonly definitions: Map<string, TestDefinition>
  private stdoutBuffer = ''
  private pending?: {
    /** `undefined` for the unsolicited `ready` handshake. */
    id?: number
    resolve: (result: BridgeResult) => void
    reject: (error: Error) => void
  }
  private requestSeq = 0
  private exited = false
  private exitReason?: string

  constructor(options: BridgeExecutorOptions) {
    this.options = options
    this.definitions = new Map(options.testDefinitions.map((d) => [d.testId, d]))
  }

  /**
   * Spawns the client and waits for its `ready` handshake. Called once before the consumer
   * registers, so a client that cannot start fails the run rather than every test in turn.
   */
  async start(): Promise<void> {
    const { interpreter, args = [], cwd, env } = this.options
    this.options.log(`🐍 Starting external client: ${interpreter} ${args.join(' ')}`)

    const child = spawn(interpreter, args, {
      cwd,
      env: { ...clientEnv(), ...this.resolveRuntimeEnv(), ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.options.log(`   [client] ${line}`)
      }
    })

    child.on('error', (error) => {
      this.exited = true
      this.exitReason = `client failed to start: ${error.message}`
      this.failPending(this.exitReason)
    })

    child.on('exit', (code, signal) => {
      this.exited = true
      this.exitReason = `client exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      this.failPending(this.exitReason)
    })

    await this.waitForReady()
  }

  /**
   * Hands the client the same Bare runtime the JS legs use. A non-JS client cannot resolve `bare-
   * runtime-<platform>-<arch>` through Node, and resolving it here keeps a platform-specific path
   * out of the config.
   */
  private resolveRuntimeEnv(): Record<string, string> {
    const from = this.options.resolveBareFrom
    if (!from || process.env.QVAC_BARE_PATH) return {}

    try {
      // Same resolution the JS client performs: the platform package exports a map of binary name
      // -> absolute path. Its `exports` field hides package.json, so go through the module rather
      // than the manifest.
      const require = createRequire(path.join(from, 'noop.js'))
      const pkg = `bare-runtime-${process.platform}-${process.arch}`
      const binaries = require(pkg) as Record<string, string>
      const binary = binaries.bare
      if (!binary) throw new Error(`${pkg} exposes no "bare" binary`)
      ensureExecutable(binary)
      this.options.log(`   Bare runtime: ${binary}`)
      return { QVAC_BARE_PATH: binary }
    } catch {
      // Not fatal: the client may bundle its own runtime, or the user may set QVAC_BARE_PATH
      // themselves. Let the client report what it is missing.
      this.options.log('   Bare runtime not resolvable here; leaving QVAC_BARE_PATH to the client')
      return {}
    }
  }

  private waitForReady(): Promise<void> {
    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`External client did not report ready within ${timeoutMs / 1000}s`))
      }, timeoutMs)

      this.pending = {
        id: undefined,
        resolve: () => {
          clearTimeout(timer)
          this.pending = undefined
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          this.pending = undefined
          reject(error)
        }
      }
    })
  }

  private onStdout(chunk: string) {
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      // One protocol message is bounded; a client that never terminates a line is not, and
      // buffering it to exhaustion turns a client bug into a dead runner with no explanation.
      const reason =
        `client exceeded ${MAX_LINE_BYTES} bytes without completing a line; ` +
        'treating it as unresponsive'
      this.stdoutBuffer = ''
      this.exitReason = reason
      this.failPending(reason)
      void this.stop()
      return
    }
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line) this.onMessage(line)
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private onMessage(line: string) {
    let message: Omit<BridgeResult, 'type'> & { type?: string; message?: string }
    try {
      message = JSON.parse(line)
    } catch {
      // Anything the client prints that is not protocol is still worth seeing.
      this.options.log(`   [client] ${line}`)
      return
    }

    if (message.type === 'log') {
      this.options.log(`   [client] ${message.message ?? ''}`)
      return
    }

    if (message.type === 'ready') {
      this.pending?.resolve({ ...message, type: 'result' } as BridgeResult)
      return
    }

    if (message.type === 'result') {
      const pending = this.pending
      if (!pending || (pending.id !== undefined && message.id !== pending.id)) {
        this.options.log(`   [client] dropped a result for request ${message.id ?? '(none)'}`)
        return
      }
      this.pending?.resolve({ ...message, type: 'result' } as BridgeResult)
      return
    }

    this.options.log(`   [client] unexpected message: ${line}`)
  }

  private failPending(reason: string) {
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error(reason))
  }

  private send(payload: unknown) {
    if (!this.child || this.exited) {
      throw new Error(this.exitReason ?? 'External client is not running')
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private request(payload: Record<string, unknown>): Promise<BridgeResult> {
    return new Promise<BridgeResult>((resolve, reject) => {
      if (this.pending) {
        this.failPending('superseded by a later request; the client fell behind')
      }
      const id = ++this.requestSeq
      this.pending = { id, resolve, reject }
      try {
        this.send({ ...payload, id })
      } catch (error: unknown) {
        this.pending = undefined
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async executeTest(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: unknown
  ): Promise<TestResult> {
    const definition = this.definitions.get(testId)

    // A definition without a declarative body is still offered to the client: some tests cannot be
    // data, and a client may carry its own body for them. It answers `incomplete` when it has none.
    const response = await this.request({
      type: 'execute',
      testId,
      params,
      expectation,
      metadata: context,
      steps: definition?.steps ?? [],
      ...(definition?.finally?.length ? { finally: definition.finally } : {})
    })

    if (response.incomplete) {
      const reason = response.reason ?? response.output ?? 'not implemented by this client'
      return { passed: false, incomplete: true, incompleteReason: reason, output: reason }
    }

    return {
      passed: Boolean(response.passed),
      output: response.output ?? '',
      ...(response.skipped ? { skipped: true } : {}),
      ...(response.assertedValue !== undefined ? { assertedValue: response.assertedValue } : {})
    }
  }

  // No per-test teardown: the client owns its own lifecycle and the process stays alive for the
  // whole run, so the optional TestExecutor.teardown hook is deliberately not implemented.

  /** Stops the client process. Idempotent. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
    try {
      this.send({ type: 'shutdown' })
      child.stdin.end()
    } catch {
      // The client is already gone; the kill below is the backstop.
    }
    // Give the client its own teardown -- closing sessions, stopping the worker it spawned --
    // before the signal. SIGTERM straight after `shutdown` leaves that undone.
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) child.kill('SIGTERM')
  }
}
