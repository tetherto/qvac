/** Fallback when neither the environment nor `qvac.config.*` sets a value. */
export const DEFAULT_RPC_INIT_TIMEOUT_MS = 30_000

/**
 * Windows-only fallback. A cold first start faults in ~139 MB of unseen native
 * code while Defender scans it — the win32-x64 addon ships as a single
 * statically linked module where other platforms keep per-backend libraries —
 * so the portable default is exceeded exactly on the run a new user takes
 * first. Warm starts settle in ~2 s, so the higher ceiling only costs a later
 * timeout report on a genuinely stuck spawn; a worker that already exited
 * still fails fast through the startup-error path.
 */
export const WIN32_RPC_INIT_TIMEOUT_MS = 120_000

function defaultRpcInitTimeoutMs(platform: string): number {
  return platform === 'win32' ? WIN32_RPC_INIT_TIMEOUT_MS : DEFAULT_RPC_INIT_TIMEOUT_MS
}

/**
 * Overrides `rpcInitTimeoutMs` from the config file. Read before the worker is
 * spawned, so it is the only knob available to hosts that cannot ship a config
 * file (packaged apps, CI images, one-off debugging runs).
 */
export const RPC_INIT_TIMEOUT_ENV_VAR = 'QVAC_RPC_INIT_TIMEOUT_MS'

interface ResolveRPCInitTimeoutOptions {
  envValue?: string | undefined
  /** Already checked against `z.number().int().positive()` by config validation. */
  configValue?: number | undefined
  /** Invoked for a rejected environment value, so this module needs no logger. */
  onInvalidEnvValue?: (envValue: string) => void
  /** Selects the built-in default; defaults to `process.platform`. */
  platform?: string | undefined
}

/**
 * Resolve the worker handshake timeout: environment variable, then config file,
 * then the built-in default.
 *
 * Only the environment is checked, being free text that reaches here
 * unvalidated. It is reported and skipped rather than thrown, because a
 * mistyped tuning value must not become a hard SDK initialization failure.
 */
export function resolveRPCInitTimeoutMs({
  envValue,
  configValue,
  onInvalidEnvValue,
  platform = process.platform
}: ResolveRPCInitTimeoutOptions = {}): number {
  if (envValue !== undefined && envValue.trim() !== '') {
    const parsed = Number(envValue)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
    onInvalidEnvValue?.(envValue)
  }

  return configValue ?? defaultRpcInitTimeoutMs(platform)
}
