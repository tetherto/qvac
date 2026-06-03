import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible'

// Options shared by every mode. `mode` is the discriminant; it defaults to
// `'external'` so existing v1 callers (which never passed `mode`) keep the
// exact same behaviour.
interface QvacCommonOptions {
  readonly apiKey?: string
  readonly headers?: Record<string, string>
  readonly fetch?: typeof fetch
}

// External mode (default): the provider is a thin wrapper around a
// `qvac serve openai` HTTP endpoint that the caller runs and supervises
// themselves. This is the v1 (0.1.0) surface, unchanged.
export interface QvacExternalOptions extends QvacCommonOptions {
  readonly mode?: 'external'
  readonly baseURL?: string
}

// Managed mode: the provider synthesizes an ephemeral `qvac.config.json` from
// the requested model alias list, spawns `qvac serve openai` on a free port,
// health-checks it, and tears the process down on host exit. `createQvac`
// returns a `Promise<ManagedQvacProvider>` in this mode.
export interface QvacManagedOptions extends QvacCommonOptions {
  readonly mode: 'managed'
  // SDK model-constant names (e.g. `'QWEN3_600M_INST_Q4'`). Each becomes a
  // serve alias of the same name, so `provider('QWEN3_600M_INST_Q4')` works.
  readonly models: readonly string[]
  // Pin the serve port. Omit to auto-allocate a free port.
  readonly servePort?: number
  // Bind host for the spawned serve. Defaults to `127.0.0.1`.
  readonly serveHost?: string
  // Max time (ms) to wait for the serve to become healthy before failing.
  // Generous by default: the port stays closed until models finish preloading,
  // and a cold P2P model download can take minutes.
  readonly serveStartTimeout?: number
  // Override the `qvac` binary. When set it is spawned directly; otherwise the
  // optional `@qvac/cli` peer dependency is resolved and run via Node.
  readonly serveBinPath?: string
}

export type QvacOptions = QvacExternalOptions | QvacManagedOptions

// Phantom-branded re-export of the underlying provider. The brand exists only
// at the type level (added via `as QvacProvider` in `createQvac`) so callers
// can distinguish a QVAC provider from any other OpenAI-compatible one in
// TypeScript without paying runtime cost.
export type QvacProvider = OpenAICompatibleProvider & {
  readonly _brand: 'qvac'
}

// Provider returned by managed mode. Carries the live serve coordinates plus a
// teardown handle. Implements `AsyncDisposable` so callers can use
// `await using qvac = await createQvac({ mode: 'managed', ... })`.
export interface ManagedQvacProvider extends QvacProvider {
  // Base URL of the spawned serve, including the `/v1` suffix.
  readonly baseURL: string
  // Port the serve is listening on (resolved even when auto-allocated).
  readonly port: number
  // PID of the spawned `qvac serve` process.
  readonly pid: number
  // Stop the serve (SIGTERM → grace → SIGKILL), remove teardown handlers, and
  // clean up the ephemeral config + PID file. Idempotent.
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}
