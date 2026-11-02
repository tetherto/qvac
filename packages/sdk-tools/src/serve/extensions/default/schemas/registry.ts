import { z } from 'zod'
import type { ModelRegistryEntryAddon } from '@qvac/sdk'

// A record so a new SDK addon fails the typecheck until it is listed here.
const ADDONS: Record<ModelRegistryEntryAddon, true> = {
  llm: true,
  whisper: true,
  bci: true,
  embeddings: true,
  nmt: true,
  vad: true,
  tts: true,
  ocr: true,
  parakeet: true,
  'moss-transcribe': true,
  diffusion: true,
  audiogen: true,
  vla: true,
  classification: true,
  other: true
}

export const REGISTRY_ADDONS = Object.keys(ADDONS) as [
  ModelRegistryEntryAddon,
  ...ModelRegistryEntryAddon[]
]

export const registryModelsQuery = z.object({
  search: z
    .string()
    .optional()
    .describe('Case-insensitive substring match on name, registry path, addon or engine.'),
  addon: z.enum(REGISTRY_ADDONS).optional().describe('Addon / capability category.'),
  engine: z.string().optional().describe('Inference engine, e.g. `llamacpp-completion`.'),
  quantization: z.string().optional().describe('Quantization, e.g. `q4`.'),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('Page size. Omit for no limit (returns all matching entries).'),
  offset: z.coerce.number().int().min(0).optional().describe('Rows to skip (default 0).')
})

export const registryLookupQuery = z.object({
  registrySource: z.string().min(1).describe('Registry source of the entry, e.g. `hf`.'),
  registryPath: z.string().min(1).describe('Registry path of the entry, as listed.')
})

// Loose, with open strings for addon and engine, so an entry the registry adds
// later still reaches the client through the response serializer.
export const registryModel = z.looseObject({
  name: z.string().describe('Catalog name of the entry.'),
  registryPath: z.string(),
  registrySource: z.string(),
  modelId: z.string().describe('File name of the model.'),
  addon: z.string(),
  engine: z.string(),
  quantization: z.string(),
  params: z.string().describe('Parameter-count label, e.g. `7B`.'),
  expectedSize: z.number().describe('Model file size in bytes.'),
  sha256Checksum: z.string(),
  blobCoreKey: z.string(),
  blobBlockOffset: z.number(),
  blobBlockLength: z.number(),
  blobByteOffset: z.number()
})

export const registryModelsResult = z.object({
  object: z.literal('list'),
  data: z.array(registryModel),
  has_more: z.boolean()
})

export const REGISTRY_FIELD_CODES: Record<string, string> = {
  addon: 'invalid_addon',
  registrySource: 'invalid_registry_source',
  registryPath: 'invalid_registry_path'
}
