import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { InvalidOptionError } from './errors.js'

// Every knob the plugin exposes, fully resolved (defaults applied). The plugin
// resolves these once and hands the model-loading subset to the host via env.
export interface ResolvedOptions {
  // Friendly models.dev id (`qwen3.5-9b`) or a raw QVAC constant. Both resolve
  // through the provider's `qvacCatalog`.
  readonly model: string
  // Serve context window. The serve default (1024) is far too small for an
  // agent's system prompt + tool schemas (~26k tokens), so default high.
  readonly ctxSize: number
  // `-1` keeps the model's reasoning channel on (matches hosted Qwen3.5); `0`
  // disables it.
  readonly reasoningBudget: number
  // Enable the tool-calling chat template. Without it the model narrates shell
  // commands as prose instead of emitting structured tool_calls.
  readonly tools: boolean
  // Apply the OpenAI-compat transforms (array-content flatten + `<think>`
  // reasoning split). Turn off once serve closes those gaps; the proxy itself
  // stays (it provides the instant-listen startup decoupling).
  readonly shim: boolean
  // Path to the node/bun runtime that hosts the serve. Auto-detected when unset.
  readonly runtime: string | undefined
  // Budget for the serve to become healthy, including a cold model download.
  readonly readyTimeoutMs: number
  // Budget for the host proxy to begin listening (not the model download). The
  // plugin only blocks startup on this; it is near-instant.
  readonly listenTimeoutMs: number
  // Mirror host milestones onto OpenCode's stderr and enable per-request traces.
  readonly debug: boolean
  // Force `qvac/<model>` as this project's default + small model so plain
  // `opencode` uses it. Off leaves any user-configured default untouched.
  readonly setDefaultModel: boolean
}

export const DEFAULT_OPTIONS: ResolvedOptions = {
  model: 'qwen3.5-9b',
  ctxSize: 32768,
  reasoningBudget: -1,
  tools: true,
  shim: true,
  runtime: undefined,
  readyTimeoutMs: 1_800_000,
  listenTimeoutMs: 30_000,
  debug: false,
  setDefaultModel: true
}

// A partial, unvalidated option set from any single source (qvac.json, the
// opencode.json plugin tuple, or env). `unknown` values are validated by
// `coerce*` before they reach `ResolvedOptions`.
export type RawOptions = Partial<Record<keyof ResolvedOptions, unknown>>

function coerceString (option: string, value: unknown): string {
  if (typeof value !== 'string') throw new InvalidOptionError(option, `expected a string, got ${typeof value}`)
  return value
}

function coerceNumber (option: string, value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new InvalidOptionError(option, `expected a number, got ${JSON.stringify(value)}`)
  return n
}

function coerceBoolean (option: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new InvalidOptionError(option, `expected a boolean, got ${JSON.stringify(value)}`)
}

// Merge raw option sources left-to-right (later sources win) onto the defaults,
// validating each provided value. Pure — no disk or env access — so the
// precedence and coercion rules are trivially unit-testable.
export function mergeOptions (...sources: readonly RawOptions[]): ResolvedOptions {
  const merged: RawOptions = {}
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) merged[key as keyof ResolvedOptions] = value
    }
  }
  return {
    model: merged.model === undefined ? DEFAULT_OPTIONS.model : coerceString('model', merged.model),
    ctxSize: merged.ctxSize === undefined ? DEFAULT_OPTIONS.ctxSize : coerceNumber('ctxSize', merged.ctxSize),
    reasoningBudget:
      merged.reasoningBudget === undefined
        ? DEFAULT_OPTIONS.reasoningBudget
        : coerceNumber('reasoningBudget', merged.reasoningBudget),
    tools: merged.tools === undefined ? DEFAULT_OPTIONS.tools : coerceBoolean('tools', merged.tools),
    shim: merged.shim === undefined ? DEFAULT_OPTIONS.shim : coerceBoolean('shim', merged.shim),
    runtime: merged.runtime === undefined ? DEFAULT_OPTIONS.runtime : coerceString('runtime', merged.runtime),
    readyTimeoutMs:
      merged.readyTimeoutMs === undefined
        ? DEFAULT_OPTIONS.readyTimeoutMs
        : coerceNumber('readyTimeoutMs', merged.readyTimeoutMs),
    listenTimeoutMs:
      merged.listenTimeoutMs === undefined
        ? DEFAULT_OPTIONS.listenTimeoutMs
        : coerceNumber('listenTimeoutMs', merged.listenTimeoutMs),
    debug: merged.debug === undefined ? DEFAULT_OPTIONS.debug : coerceBoolean('debug', merged.debug),
    setDefaultModel:
      merged.setDefaultModel === undefined
        ? DEFAULT_OPTIONS.setDefaultModel
        : coerceBoolean('setDefaultModel', merged.setDefaultModel)
  }
}

// Map QVAC_* env vars onto raw options. Only set keys are returned, so env
// participates in the same precedence merge as the other sources.
export function optionsFromEnv (env: NodeJS.ProcessEnv): RawOptions {
  const raw: RawOptions = {}
  if (env['QVAC_MODEL'] !== undefined) raw.model = env['QVAC_MODEL']
  if (env['QVAC_CTX_SIZE'] !== undefined) raw.ctxSize = env['QVAC_CTX_SIZE']
  if (env['QVAC_REASONING_BUDGET'] !== undefined) raw.reasoningBudget = env['QVAC_REASONING_BUDGET']
  if (env['QVAC_TOOLS'] !== undefined) raw.tools = env['QVAC_TOOLS']
  if (env['QVAC_SHIM'] !== undefined) raw.shim = env['QVAC_SHIM']
  if (env['QVAC_RUNTIME'] !== undefined) raw.runtime = env['QVAC_RUNTIME']
  if (env['QVAC_READY_TIMEOUT_MS'] !== undefined) raw.readyTimeoutMs = env['QVAC_READY_TIMEOUT_MS']
  if (env['QVAC_LISTEN_TIMEOUT_MS'] !== undefined) raw.listenTimeoutMs = env['QVAC_LISTEN_TIMEOUT_MS']
  if (env['QVAC_DEBUG'] !== undefined) raw.debug = env['QVAC_DEBUG']
  if (env['QVAC_SET_DEFAULT_MODEL'] !== undefined) raw.setDefaultModel = env['QVAC_SET_DEFAULT_MODEL']
  return raw
}

// Read an optional `qvac.json` from the project directory. A missing file is
// not an error (env / plugin options can supply everything); a malformed one
// is, so a typo doesn't silently fall back to defaults.
export function optionsFromProjectFile (projectDir: string): RawOptions {
  let text: string
  try {
    text = readFileSync(join(projectDir, 'qvac.json'), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidOptionError('qvac.json', 'expected a JSON object')
    }
    return parsed as RawOptions
  } catch (err) {
    if (err instanceof InvalidOptionError) throw err
    throw new InvalidOptionError('qvac.json', `not valid JSON (${String(err)})`)
  }
}

// Resolve effective options from all sources. Precedence, lowest to highest:
// defaults < qvac.json < opencode.json plugin options < QVAC_* env. Env wins so
// an ad-hoc `QVAC_MODEL=… opencode` override always takes effect.
export function resolveOptions (params: {
  pluginOptions?: RawOptions | undefined
  projectDir: string
  env: NodeJS.ProcessEnv
}): ResolvedOptions {
  return mergeOptions(
    optionsFromProjectFile(params.projectDir),
    params.pluginOptions ?? {},
    optionsFromEnv(params.env)
  )
}

// The env subset the host needs to load + serve the model. The plugin resolves
// options once (honouring qvac.json + plugin tuple) and passes the resolved
// values to the host so the host never re-reads config.
export function hostEnv (options: ResolvedOptions): Record<string, string> {
  return {
    QVAC_MODEL: options.model,
    QVAC_CTX_SIZE: String(options.ctxSize),
    QVAC_REASONING_BUDGET: String(options.reasoningBudget),
    QVAC_TOOLS: String(options.tools),
    QVAC_SHIM: String(options.shim),
    QVAC_READY_TIMEOUT_MS: String(options.readyTimeoutMs),
    QVAC_DEBUG: String(options.debug)
  }
}
