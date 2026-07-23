import { allModels } from './constants.js'

// Public, models.dev-style model catalog.
//
// QVAC's SDK identifies every model by a verbose constant
// (`QWEN3_5_9B_MULTIMODAL_Q4_K_M`) that encodes family, size, modality and
// quantization. Coding-agent ecosystems (OpenCode, Cline, Continue, …) instead
// discover models through the models.dev catalog, which uses short, friendly
// ids (`qwen3.5-9b`). For a request to resolve end-to-end, those two id spaces
// have to agree somewhere.
//
// This catalog is that single, shared point of agreement: it maps each public
// models.dev id to the SDK constant the serve actually loads (pinning the
// default quantization in the process). Keep the `id` values byte-identical to
// the models.dev `qvac` provider TOML filenames so the id a user picks is the
// same string from the catalog UI, through the provider, to the serve.
export interface QvacCatalogEntry {
  // Public, models.dev-style id (e.g. `'qwen3.5-9b'`). Matches the TOML filename.
  readonly id: string
  // SDK model-constant name the serve loads for this id (default quantization).
  readonly constant: string
  // Human label for model pickers (e.g. `'Qwen3.5 9B'`).
  readonly name: string
}

// Public provider catalog entries, defaulting to the quantization shipped to
// models.dev for each friendly id.
export const qvacCatalog: readonly QvacCatalogEntry[] = [
  { id: 'qwen3.5-0.8b', constant: 'QWEN3_5_0_8B_MULTIMODAL_Q4_K_M', name: 'Qwen3.5 0.8B' },
  { id: 'qwen3.5-2b', constant: 'QWEN3_5_2B_MULTIMODAL_Q4_K_M', name: 'Qwen3.5 2B' },
  { id: 'qwen3.5-4b', constant: 'QWEN3_5_4B_MULTIMODAL_Q4_K_M', name: 'Qwen3.5 4B' },
  { id: 'qwen3.5-9b', constant: 'QWEN3_5_9B_MULTIMODAL_Q4_K_M', name: 'Qwen3.5 9B' },
  { id: 'qwen3.6-27b', constant: 'QWEN3_6_27B_MULTIMODAL_Q4_K_XL', name: 'Qwen3.6 27B' },
  { id: 'qwen3.6-35b-a3b', constant: 'QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M', name: 'Qwen3.6 35B A3B' },
  { id: 'gpt-oss-20b', constant: 'GPT_OSS_20B_INST_Q4_K_M', name: 'GPT-OSS 20B' },
  { id: 'gemma4-31b', constant: 'GEMMA4_31B_MULTIMODAL_Q4_K_M', name: 'Gemma4 31B' }
]

const byId = new Map(qvacCatalog.map((entry) => [entry.id, entry]))
const byConstant = new Map(qvacCatalog.map((entry) => [entry.constant, entry]))

// Find the catalog entry for either a public id (`qwen3.5-9b`) or its SDK
// constant (`QWEN3_5_9B_MULTIMODAL_Q4_K_M`). Returns `undefined` for ids/
// constants not in the catalog (e.g. a bare constant with no friendly alias).
export function findCatalogEntry(idOrConstant: string): QvacCatalogEntry | undefined {
  return byId.get(idOrConstant) ?? byConstant.get(idOrConstant)
}

// True when `id` is a public catalog id (not a constant).
export function isCatalogId(id: string): boolean {
  return byId.has(id)
}

// Resolve any catalog id (or constant) to the SDK constant the serve must load.
// A value that is not a catalog id passes through unchanged, so raw constants —
// including ones with no friendly alias — keep working.
export function resolveModelConstant(idOrConstant: string): string {
  return byId.get(idOrConstant)?.constant ?? idOrConstant
}

// Names of every model constant in the generated SDK catalog. Used to guard the
// hand-written entries above against drift (see the catalog unit test).
const KNOWN_CONSTANTS: ReadonlySet<string> = new Set(allModels.map((m) => m.name))

// The catalog ids whose constant is missing from the generated SDK catalog.
// Empty in a healthy build; the unit test asserts it stays empty so a renamed
// or removed constant fails CI instead of 500-ing at request time.
export function catalogEntriesWithUnknownConstant(): readonly QvacCatalogEntry[] {
  return qvacCatalog.filter((entry) => !KNOWN_CONSTANTS.has(entry.constant))
}
