import type { TestDefinition } from '@qvac/test-suite'
import { collectTestDeps } from './collect-test-deps.js'

/** JSON array of dep keys from the CI model-cache plan; narrows a standalone bootstrap. */
export const BOOTSTRAP_DEPS_ENV = 'QVAC_E2E_BOOTSTRAP_DEPS'

/** JSON array of model names the CI cache restore did not provide. */
export const BOOTSTRAP_MODELS_ENV = 'QVAC_E2E_BOOTSTRAP_MODELS'

function readStringArray(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  what: string
): ReadonlySet<string> | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${name} must be a JSON array of ${what}, got: ${raw}`)
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error(`${name} must be a JSON array of ${what}, got: ${raw}`)
  }
  return new Set(parsed)
}

/**
 * Deps to pre-download: the producer's test list inside a run, else the CI plan's env, else
 * `undefined` (everything).
 */
export function resolveBootstrapDeps(
  filteredTests: readonly TestDefinition[] | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env
): ReadonlySet<string> | undefined {
  if (filteredTests) return collectTestDeps(filteredTests)

  return readStringArray(env, BOOTSTRAP_DEPS_ENV, 'dep keys')
}

/** Model names a standalone bootstrap is limited to; `undefined` is no limit. */
export function resolveBootstrapModels(
  env: Readonly<Record<string, string | undefined>> = process.env
): ReadonlySet<string> | undefined {
  return readStringArray(env, BOOTSTRAP_MODELS_ENV, 'model names')
}
