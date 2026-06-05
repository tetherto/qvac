import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { allModels } from '../models/constants.js'
import type { QvacManagedModel } from '../types.js'
import { UnknownManagedModelError } from './errors.js'

// A model as accepted by managed mode: a bare constant name, or an object with
// per-model serve config.
export type ManagedModelInput = string | QvacManagedModel

// Each requested model constant becomes a serve alias of the same name, so a
// caller's `provider('QWEN3_600M_INST_Q4')` maps 1:1 to the synthesized entry.
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

function normalizeModel (input: ManagedModelInput): QvacManagedModel {
  return typeof input === 'string' ? { name: input } : input
}

// Resolve the alias names from a model list (used to key the serve aliases and
// for diagnostics). Preserves order and duplicates.
export function modelNames (models: readonly ManagedModelInput[]): string[] {
  return models.map((m) => normalizeModel(m).name)
}

// Validates the requested model names against the generated catalog and builds
// the `qvac.config.json` shape. Pure — no filesystem side effects — so it is
// trivial to unit test the JSON it produces.
export function synthesizeServeConfig (models: readonly ManagedModelInput[]): SynthesizedServeConfig {
  if (models.length === 0) {
    throw new UnknownManagedModelError([])
  }

  const specs = models.map(normalizeModel)

  const unknown = specs.filter((s) => !KNOWN_MODEL_NAMES.has(s.name)).map((s) => s.name)
  if (unknown.length > 0) {
    throw new UnknownManagedModelError(unknown)
  }

  // Default alias: an explicit `default: true` wins; otherwise the first model.
  const hasExplicitDefault = specs.some((s) => s.default === true)

  const entries: Record<string, SynthesizedModelEntry> = {}
  specs.forEach((spec, index) => {
    const isDefault = spec.default ?? (!hasExplicitDefault && index === 0)
    entries[spec.name] = {
      model: spec.name,
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
export async function writeEphemeralConfig (models: readonly ManagedModelInput[]): Promise<EphemeralConfig> {
  const config = synthesizeServeConfig(models)
  const dir = await mkdtemp(join(tmpdir(), 'qvac-managed-'))
  const configPath = join(dir, 'qvac.config.json')
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  let cleaned = false
  async function cleanup () {
    if (cleaned) return
    cleaned = true
    await rm(dir, { recursive: true, force: true })
  }

  return { configPath, cleanup }
}

// Exposed for tests/diagnostics: a fresh, unguessable temp filename helper.
export function ephemeralConfigName (): string {
  return `qvac.config.${randomBytes(6).toString('hex')}.json`
}
