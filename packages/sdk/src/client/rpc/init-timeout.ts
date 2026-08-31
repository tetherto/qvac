/** Fallback when neither the environment nor `qvac.config.*` sets a value. */
export const DEFAULT_RPC_INIT_TIMEOUT_MS = 30_000

/**
 * Overrides `rpcInitTimeoutMs` from the config file. Read before the worker is
 * spawned, so it is the only knob available to hosts that cannot ship a config
 * file (packaged apps, CI images, one-off debugging runs).
 */
export const RPC_INIT_TIMEOUT_ENV_VAR = 'QVAC_RPC_INIT_TIMEOUT_MS'

interface ResolveRPCInitTimeoutOptions {
  envValue?: string | undefined
  configValue?: number | undefined
  /** Invoked for a rejected override so the caller can log without this module owning a logger. */
  onInvalid?: (source: string, value: string) => void
}

function toPositiveInteger(value: number): number | null {
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * Resolve the worker handshake timeout: environment variable, then config file,
 * then the built-in default. An override that is not a positive integer is
 * reported and skipped rather than thrown, because rejecting it would turn a
 * mistyped tuning value into a hard SDK initialization failure.
 */
export function resolveRPCInitTimeoutMs({
  envValue,
  configValue,
  onInvalid
}: ResolveRPCInitTimeoutOptions = {}): number {
  if (envValue !== undefined && envValue.trim() !== '') {
    const parsed = Number(envValue)
    const valid = Number.isFinite(parsed) ? toPositiveInteger(parsed) : null
    if (valid !== null) return valid
    onInvalid?.(RPC_INIT_TIMEOUT_ENV_VAR, envValue)
  }

  if (configValue !== undefined) {
    const valid = toPositiveInteger(configValue)
    if (valid !== null) return valid
    onInvalid?.('rpcInitTimeoutMs', String(configValue))
  }

  return DEFAULT_RPC_INIT_TIMEOUT_MS
}
