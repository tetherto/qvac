import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { allModels } from '../models/constants.js'
import { UnknownManagedModelError } from './errors.js'

// Each requested model constant becomes a serve alias of the same name, so a
// caller's `provider('QWEN3_600M_INST_Q4')` maps 1:1 to the synthesized entry.
interface SynthesizedModelEntry {
  readonly model: string
  readonly preload: true
  readonly default?: true
}

export interface SynthesizedServeConfig {
  readonly serve: {
    readonly models: Record<string, SynthesizedModelEntry>
  }
}

const KNOWN_MODEL_NAMES: ReadonlySet<string> = new Set(allModels.map((m) => m.name))

// Validates the requested model names against the generated catalog and builds
// the `qvac.config.json` shape. Pure — no filesystem side effects — so it is
// trivial to unit test the JSON it produces.
export function synthesizeServeConfig (models: readonly string[]): SynthesizedServeConfig {
  if (models.length === 0) {
    throw new UnknownManagedModelError([])
  }

  const unknown = models.filter((name) => !KNOWN_MODEL_NAMES.has(name))
  if (unknown.length > 0) {
    throw new UnknownManagedModelError(unknown)
  }

  const entries: Record<string, SynthesizedModelEntry> = {}
  models.forEach((name, index) => {
    entries[name] = index === 0
      ? { model: name, preload: true, default: true }
      : { model: name, preload: true }
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
export async function writeEphemeralConfig (models: readonly string[]): Promise<EphemeralConfig> {
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
