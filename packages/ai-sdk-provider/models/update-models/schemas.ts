// Build-time-only mirror of the schema constants that the SDK exposes
// internally under `@/schemas/registry`, `@/schemas/engine-addon-map`,
// `@/schemas` (BERGAMOT_MODEL_RE), and `@/constants` (DEFAULT_REGISTRY_CORE_KEY).
//
// The SDK does not export these in its public API, so we reproduce them here.
// This file lives under `models/update-models/` which is NEVER bundled into the
// published package — runtime stays clean. The trade-off is a small maintenance
// touch every time the SDK adds a new engine / addon / legacy alias; the SDK's
// own `models/update-models/` is the source of truth and this file should be
// kept in lockstep with it.

// Canonical engine values mirror `ModelType` from
// packages/sdk/schemas/model-types.ts plus the registry-only `onnx-vad` engine.
export const CANONICAL_ENGINES = [
  'llamacpp-completion',
  'whispercpp-transcription',
  'llamacpp-embedding',
  'nmtcpp-translation',
  'onnx-tts',
  'tts-ggml',
  'onnx-ocr',
  'parakeet-transcription',
  'sdcpp-generation',
  'ggml-vla',
  'ggml-classification',
  'onnx-vad'
] as const

export type ModelRegistryEngine = (typeof CANONICAL_ENGINES)[number]

// Addon enum mirrors `modelRegistryEntryAddonSchema` from packages/sdk/schemas/registry.ts.
export const REGISTRY_ADDONS = [
  'llm',
  'whisper',
  'embeddings',
  'nmt',
  'vad',
  'tts',
  'ocr',
  'parakeet',
  'diffusion',
  'vla',
  'classification',
  'other'
] as const

export type ModelRegistryEntryAddon = (typeof REGISTRY_ADDONS)[number]

// Canonical engine → addon mapping. Mirrors `ENGINE_TO_ADDON` from
// packages/sdk/schemas/engine-addon-map.ts.
export const ENGINE_TO_ADDON = {
  'llamacpp-completion': 'llm',
  'whispercpp-transcription': 'whisper',
  'llamacpp-embedding': 'embeddings',
  'nmtcpp-translation': 'nmt',
  'onnx-tts': 'tts',
  'tts-ggml': 'tts',
  'onnx-ocr': 'ocr',
  'parakeet-transcription': 'parakeet',
  'sdcpp-generation': 'diffusion',
  'ggml-vla': 'vla',
  'ggml-classification': 'classification',
  'onnx-vad': 'vad'
} as const satisfies Record<ModelRegistryEngine, ModelRegistryEntryAddon>

// Legacy engine names → canonical. Mirrors `LEGACY_ENGINE_TO_CANONICAL` from
// packages/sdk/schemas/engine-addon-map.ts. Used to normalise older registry
// entries that still carry `@qvac/*` package names or tag-style strings.
const LEGACY_ENGINE_TO_CANONICAL: Record<string, ModelRegistryEngine> = {
  llm: 'llamacpp-completion',
  whisper: 'whispercpp-transcription',
  embeddings: 'llamacpp-embedding',
  nmt: 'nmtcpp-translation',
  tts: 'tts-ggml',
  ocr: 'onnx-ocr',
  parakeet: 'parakeet-transcription',
  vad: 'onnx-vad',
  generation: 'llamacpp-completion',
  transcription: 'whispercpp-transcription',
  embedding: 'llamacpp-embedding',
  translation: 'nmtcpp-translation',
  diffusion: 'sdcpp-generation',
  vla: 'ggml-vla',
  classification: 'ggml-classification',
  '@qvac/llm-llamacpp': 'llamacpp-completion',
  '@qvac/transcription-whispercpp': 'whispercpp-transcription',
  '@qvac/embed-llamacpp': 'llamacpp-embedding',
  '@qvac/translation-nmtcpp': 'nmtcpp-translation',
  '@qvac/translation-llamacpp': 'nmtcpp-translation',
  '@qvac/vad-silero': 'onnx-vad',
  '@qvac/tts': 'tts-ggml',
  '@qvac/tts-onnx': 'tts-ggml',
  '@qvac/tts-ggml': 'tts-ggml',
  '@qvac/ocr-onnx': 'onnx-ocr',
  '@qvac/transcription-parakeet': 'parakeet-transcription',
  '@qvac/diffusion-cpp': 'sdcpp-generation',
  '@qvac/vla-ggml': 'ggml-vla',
  '@qvac/classification-ggml': 'ggml-classification'
}

export function resolveCanonicalEngine(engine: string): ModelRegistryEngine | null {
  if ((CANONICAL_ENGINES as readonly string[]).includes(engine)) {
    if (engine === 'onnx-tts') return 'tts-ggml'
    return engine as ModelRegistryEngine
  }
  return LEGACY_ENGINE_TO_CANONICAL[engine] ?? null
}

export function getAddonFromEngine(engine: ModelRegistryEngine): ModelRegistryEntryAddon {
  return ENGINE_TO_ADDON[engine]
}

// Mirrors `BERGAMOT_MODEL_RE` from packages/sdk/schemas/translation-config.ts.
// Identifies the primary model file in a Bergamot NMT companion set so the
// codegen can group `lex.*`, `vocab.*`, and `metadata.json` files with it.
export const BERGAMOT_MODEL_RE = /^(.+\/)model\.([a-z]+)\.intgemm\.alphas\.bin$/

// Mirrors `DEFAULT_REGISTRY_CORE_KEY` from packages/sdk/constants/registry.ts.
// The Hyperdrive core key for the production QVAC model registry. Overridable
// via the `QVAC_REGISTRY_CORE_KEY` env var when running `bun run update-models`.
export const DEFAULT_REGISTRY_CORE_KEY = 'uf1fm44uzockp6azhcdiqt1esjgm65fwtimsh946e8kwysdes9ko'

// Addon → OpenAI-style endpoint category. Mirrors `ENDPOINT_CATEGORY` from
// packages/cli/src/serve/config.ts, restricted to the addon keys (the CLI map
// also accepts the legacy engine aliases). `vad` and `other` have no endpoint
// in the OpenAI-shaped surface today and are filtered out at codegen time.
//
// Update both this table and packages/cli/src/serve/config.ts together when a
// new addon ships a new endpoint category.
export const ADDON_TO_ENDPOINT_CATEGORY = {
  llm: 'chat',
  whisper: 'transcription',
  embeddings: 'embedding',
  nmt: 'translation',
  tts: 'speech',
  ocr: 'ocr',
  parakeet: 'transcription',
  diffusion: 'image'
} as const

export type EndpointCategory =
  | 'chat'
  | 'embedding'
  | 'transcription'
  | 'audio-translation'
  | 'translation'
  | 'speech'
  | 'ocr'
  | 'image'

export function getEndpointCategoryFromAddon(
  addon: ModelRegistryEntryAddon
): EndpointCategory | null {
  if (addon in ADDON_TO_ENDPOINT_CATEGORY) {
    return ADDON_TO_ENDPOINT_CATEGORY[addon as keyof typeof ADDON_TO_ENDPOINT_CATEGORY]
  }
  return null
}
