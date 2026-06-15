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

// A model to load in managed mode. A bare string is shorthand for `{ name }`.
// Use the object form to attach per-model serve config — notably `ctx_size`
// and `reasoning_budget`, which coding-agent harnesses like OpenCode need (the
// serve default `ctx_size` of 1024 is too small for an agent's system prompt +
// tool definitions). See the package README's "Using with coding agents".
export interface QvacManagedModel {
  // SDK model-constant name (`'GPT_OSS_20B_INST_Q4_K_M'`) or a public catalog id
  // (`'qwen3.5-9b'`, see `models.qvacCatalog`). Becomes a serve alias of the
  // same name — so `provider(name)` maps 1:1 to the entry — while a catalog id
  // resolves to its underlying SDK constant for loading.
  readonly name: string
  // Per-model serve config, merged verbatim into the synthesized
  // `qvac.config.json` entry under `config` (e.g.
  // `{ ctx_size: 32768, reasoning_budget: 0 }`).
  readonly config?: Record<string, unknown>
  // Preload the model when the serve starts. Defaults to `true`.
  readonly preload?: boolean
  // Mark this alias as the serve default. Defaults to the first model when no
  // model sets it explicitly.
  readonly default?: boolean
}

// Managed mode: the provider synthesizes an ephemeral `qvac.config.json` from
// the requested model list, spawns `qvac serve openai` on a free port,
// health-checks it, and tears the process down on host exit. `createQvac`
// returns a `Promise<ManagedQvacProvider>` in this mode.
export interface QvacManagedOptions extends QvacCommonOptions {
  readonly mode: 'managed'
  // Models to load. A bare string is an SDK model-constant name (e.g.
  // `'QWEN3_600M_INST_Q4'`) or a public catalog id (e.g. `'qwen3.5-9b'`, see
  // `models.qvacCatalog`); the object form additionally carries per-model serve
  // `config` (see `QvacManagedModel`). Each becomes a serve alias of the same
  // name, so `provider('QWEN3_600M_INST_Q4')` and `provider('qwen3.5-9b')` work.
  readonly models: readonly (string | QvacManagedModel)[]
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
  // Share a serve across processes/sessions. When true (default), managed mode
  // reuses an already-running serve whose model set + config match (the "fleet
  // key"), and only spawns a new one if none is found. Set false to force a
  // private serve for this provider.
  readonly reuse?: boolean
  // How long (ms) a shared serve keeps running after its last consumer process
  // exits, before the runner reaps it. Default: 5 minutes. Ignored when
  // `reuse` is false (a private serve is reaped as soon as its owner exits).
  readonly serveIdleTimeout?: number
  // Treat this process as a child whose lifetime must not exceed its parent's —
  // for a host whose only job is to keep a managed serve alive for a parent
  // process (e.g. an editor/agent plugin spawned by the editor). When set, the
  // provider watches its parent pid and, the moment the parent exits (on POSIX
  // we are reparented to init, ppid → 1), closes itself — deregistering the
  // consumer so the runner reaps the serve — and exits this process. Without it,
  // a reparented host would keep its consumer marker alive forever and the serve
  // would never be reaped. Default false; only meaningful for such daemon-style
  // hosts — a normal in-process consumer should leave it off.
  readonly closeOnParentExit?: boolean
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
  // Base URL of the live serve, including the `/v1` suffix. Read it fresh after
  // recovery: if the serve crashes and is respawned on a new port, this getter
  // reflects the new origin (handy for re-pointing an external client).
  readonly baseURL: string
  // Port the live serve is listening on (resolved even when auto-allocated; may
  // change after a crash-recovery respawn).
  readonly port: number
  // PID of the live `qvac serve` process backing this provider (may be shared
  // with other sessions when `reuse` is enabled, and may change after a respawn).
  readonly pid: number
  // Deregister this process as a consumer of the (possibly shared) serve and
  // remove teardown handlers. The serve itself is reaped by its detached runner
  // once no consumer remains for `serveIdleTimeout`, so a shared serve survives
  // until the last user is gone. Idempotent.
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}
