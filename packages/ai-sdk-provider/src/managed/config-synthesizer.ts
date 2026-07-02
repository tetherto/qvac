import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { allModels } from '../models/constants.js'
import { isCatalogId, resolveModelConstant } from '../models/catalog.js'
import type { QvacManagedModel } from '../types.js'
import {
  DuplicateManagedModelError,
  MultipleDefaultManagedModelsError,
  UnknownManagedModelError
} from './errors.js'

// A model as accepted by managed mode: a bare constant name, or an object with
// per-model serve config.
export type ManagedModelInput = string | QvacManagedModel

// Each requested model becomes a serve alias keyed by the name the caller gave:
//   - a bare SDK constant (`'QWEN3_600M_INST_Q4'`) → alias == constant, so
//     `provider('QWEN3_600M_INST_Q4')` maps 1:1 to the entry;
//   - a public catalog id (`'qwen3.5-9b'`) → alias == the friendly id, while
//     `model` resolves to the underlying SDK constant. This lets the serve
//     answer requests for `qwen3.5-9b` directly (matching models.dev), with no
//     id translation needed in front of it.
// `config` carries per-model serve settings (ctx_size, reasoning_budget, …).
interface SynthesizedModelEntry {
  readonly model: string
  readonly preload: boolean
  readonly default?: true
  readonly config?: Record<string, unknown>
}

export interface SynthesizedServeConfig {
  readonly serve: {
    readonly models: Record<string, SynthesizedModelEntry>
  }
}

const KNOWN_MODEL_NAMES: ReadonlySet<string> = new Set(allModels.map((m) => m.name))

// A model name is valid if it is a generated SDK constant or a public catalog
// id (which resolves to a constant). Anything else is rejected up front.
function isKnownModelName(name: string): boolean {
  return KNOWN_MODEL_NAMES.has(name) || isCatalogId(name)
}

function normalizeModel(input: ManagedModelInput): QvacManagedModel {
  return typeof input === 'string' ? { name: input } : input
}

// Resolve the alias names from a model list (used to key the serve aliases and
// for diagnostics). Preserves order and duplicates.
export function modelNames(models: readonly ManagedModelInput[]): string[] {
  return models.map((m) => normalizeModel(m).name)
}

// Validates the requested model names against the generated catalog and builds
// the `qvac.config.json` shape. Pure — no filesystem side effects — so it is
// trivial to unit test the JSON it produces.
export function synthesizeServeConfig(
  models: readonly ManagedModelInput[]
): SynthesizedServeConfig {
  if (models.length === 0) {
    throw new UnknownManagedModelError([])
  }

  const specs = models.map(normalizeModel)

  const unknown = specs.filter((s) => !isKnownModelName(s.name)).map((s) => s.name)
  if (unknown.length > 0) {
    throw new UnknownManagedModelError(unknown)
  }

  // Each model becomes exactly one serve alias keyed by its name, so a repeat
  // would silently overwrite the earlier entry (and could drop its `default`).
  // Reject dupes up front rather than resolve them ambiguously.
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const s of specs) {
    if (seen.has(s.name)) duplicates.add(s.name)
    seen.add(s.name)
  }
  if (duplicates.size > 0) {
    throw new DuplicateManagedModelError([...duplicates])
  }

  // Default alias: an explicit `default: true` wins; otherwise the first model.
  // A serve has a single default, so reject more than one explicit default
  // rather than emit an ambiguous config the CLI resolves arbitrarily.
  const explicitDefaults = specs.filter((s) => s.default === true).map((s) => s.name)
  if (explicitDefaults.length > 1) {
    throw new MultipleDefaultManagedModelsError(explicitDefaults)
  }
  const hasExplicitDefault = explicitDefaults.length > 0

  const entries: Record<string, SynthesizedModelEntry> = {}
  specs.forEach((spec, index) => {
    const isDefault = spec.default ?? (!hasExplicitDefault && index === 0)
    // Alias is the name the caller gave (a catalog id stays friendly); `model`
    // resolves to the SDK constant a catalog id points at (or the constant
    // itself for a bare-constant input).
    entries[spec.name] = {
      model: resolveModelConstant(spec.name),
      preload: spec.preload ?? true,
      ...(isDefault ? { default: true as const } : {}),
      ...(spec.config !== undefined ? { config: spec.config } : {})
    }
  })

  return { serve: { models: entries } }
}

export interface EphemeralConfig {
  readonly configPath: string
  cleanup(): Promise<void>
}

// Writes the synthesized config to a private temp directory and returns the
// path plus an idempotent cleanup. The directory is unique per supervisor so
// concurrent managed providers never clobber each other's config.
export async function writeEphemeralConfig(
  models: readonly ManagedModelInput[]
): Promise<EphemeralConfig> {
  const config = synthesizeServeConfig(models)
  const dir = await mkdtemp(join(tmpdir(), 'qvac-managed-'))
  const configPath = join(dir, 'qvac.config.json')
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  let cleaned = false
  async function cleanup() {
    if (cleaned) return
    cleaned = true
    await rm(dir, { recursive: true, force: true })
  }

  return { configPath, cleanup }
}
