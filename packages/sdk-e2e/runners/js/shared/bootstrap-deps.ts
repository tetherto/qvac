import type { TestDefinition } from '@qvac/test-suite'
import { collectTestDeps } from './collect-test-deps.js'

/**
 * Set by CI from the leg's model-cache plan (`scripts/model-cache-plan.mjs`) so a standalone
 * `qvac-test run:bootstrap:*` downloads only what the leg's tests use. A JSON array of
 * ResourceManager dep keys; `[]` is a leg that needs no model at all.
 */
export const BOOTSTRAP_DEPS_ENV = 'QVAC_E2E_BOOTSTRAP_DEPS'

/**
 * Set by CI from the per-model cache restore: a JSON array of model constant names the cache did
 * not provide. The bootstrap then downloads only those, instead of re-verifying every restored
 * file (the run verifies each one on load anyway).
 */
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
 * The deps a desktop-side bootstrap should pre-download. The producer's post-filter test list
 * (delivered via register-ack) wins; a standalone bootstrap has none and falls back to the
 * plan CI exported. `undefined` keeps the legacy "warm everything" path.
 */
export function resolveBootstrapDeps(
  filteredTests: readonly TestDefinition[] | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env
): ReadonlySet<string> | undefined {
  if (filteredTests) return collectTestDeps(filteredTests)

  return readStringArray(env, BOOTSTRAP_DEPS_ENV, 'dep keys')
}

/** The model names a standalone bootstrap is limited to; `undefined` is no limit. */
export function resolveBootstrapModels(
  env: Readonly<Record<string, string | undefined>> = process.env
): ReadonlySet<string> | undefined {
  return readStringArray(env, BOOTSTRAP_MODELS_ENV, 'model names')
}
