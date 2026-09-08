import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_CANDIDATES } from '@/config'
import type { ServeModelEntry } from '@/configure/presets'

export interface QvacConfig {
  serve?: { models?: Record<string, ServeModelEntry>; [k: string]: unknown }
  [k: string]: unknown
}

/** A non-JSON config (qvac.config.{js,mjs,ts}) in `dir`, if any — we can't safely
 * rewrite those, so the command emits guidance instead of clobbering them. */
export function foreignConfigPath(dir: string): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    if (candidate.endsWith('.json')) continue
    const full = join(dir, candidate)
    if (existsSync(full)) return full
  }
  return null
}

/** The set of model constants/sources already configured (an entry's `model`
 * or `src`), so re-running configure is idempotent per model. */
export function existingModelIdentities(config: QvacConfig): Set<string> {
  const ids = new Set<string>()
  for (const value of Object.values(config.serve?.models ?? {})) {
    if (typeof value === 'string') {
      ids.add(value)
      continue
    }
    if (value.model) ids.add(value.model)
    if (value.src) ids.add(value.src)
  }
  return ids
}

/** Map each configured model id (its `model`/`src`) to the alias that holds it —
 * first alias wins. Lets `--force` overwrite the existing entry for a model in
 * place instead of minting a new deduped alias. */
export function existingAliasesByModel(config: QvacConfig): Map<string, string> {
  const map = new Map<string, string>()
  for (const [alias, value] of Object.entries(config.serve?.models ?? {})) {
    const id = typeof value === 'string' ? value : (value.model ?? value.src)
    if (id !== undefined && !map.has(id)) map.set(id, alias)
  }
  return map
}

export function loadJsonConfig(path: string): QvacConfig {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8').trim()
  if (raw === '') return {}
  return JSON.parse(raw) as QvacConfig
}

export interface MergeResult {
  config: QvacConfig
  added: string[]
  conflicts: string[]
}

/** Merge new aliases into `serve.models`, preserving existing keys. Without
 * `force`, an alias that already exists is reported as a conflict and skipped. */
export function mergeServeModels(
  existing: QvacConfig,
  additions: Record<string, ServeModelEntry>,
  force: boolean
): MergeResult {
  const config: QvacConfig = { ...existing }
  const serve = { ...(config.serve ?? {}) }
  const models = { ...((serve.models ?? {}) as Record<string, ServeModelEntry>) }
  const added: string[] = []
  const conflicts: string[] = []

  for (const [alias, entry] of Object.entries(additions)) {
    if (alias in models && !force) {
      conflicts.push(alias)
      continue
    }
    models[alias] = entry
    added.push(alias)
  }

  serve.models = models
  config.serve = serve
  return { config, added, conflicts }
}

export function serializeConfig(config: QvacConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** Write via a temp file + rename so a crash can't leave a half-written config. */
export function writeConfigAtomically(path: string, config: QvacConfig): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tempDir = mkdtempSync(join(dir, '.qvac-config-'))
  const tempPath = join(tempDir, 'qvac.config.json')
  try {
    writeFileSync(tempPath, serializeConfig(config), 'utf8')
    renameSync(tempPath, path)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
