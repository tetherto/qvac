import type { ModelConstant } from '@qvac/sdk'
import { loadModelConstants } from '@/serve/core/config/constants'

/**
 * Rewrites nested companion model-source fields whose value is a known SDK
 * constant name into the full `ModelConstant` object (same treatment as
 * top-level `serve.models[*].model` / `.src`).
 *
 * Matches every source key: keys ending in `Src` (e.g. `llmModelSrc`,
 * `tokenizerSrc`, `sceneSrc`, `srcVocabSrc`, `referenceAudioSrc`, and a nested
 * object's own `modelSrc` such as the parakeet `speakerAttribution` diarizer or
 * the nmt `pivot` model), source lists ending in `Srcs` (e.g.
 * `dialogueReferenceSrcs`, resolved per element), and the ESRGAN
 * `upscaler.model_src` snake_case field. Recurses into plain nested objects so
 * whisper/nmt nested configs are covered.
 *
 * Bare identifiers are looked up as constants; values with `/` or a leading
 * `.` are left as filesystem / registry paths. Unknown CONSTANT_CASE names
 * throw with the accepted forms listed.
 */
export function resolveNestedModelSrcConstants(
  config: Record<string, unknown>,
  context?: string
): Record<string, unknown> {
  const constants = loadModelConstants()
  return walk(config, constants, context ?? 'config', config['mode'] === 'video')
}

function walk(
  obj: Record<string, unknown>,
  constants: Map<string, ModelConstant>,
  path: string,
  skipUpscaler = false
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj }
  for (const [key, value] of Object.entries(out)) {
    if (skipUpscaler && key === 'upscaler') continue
    const childPath = `${path}.${key}`
    if (isModelSrcKey(key) && typeof value === 'string') {
      out[key] = resolveModelSrcString(value, constants, childPath)
      continue
    }
    if (isModelSrcKey(key) && Array.isArray(value)) {
      out[key] = value.map((item: unknown, i) =>
        typeof item === 'string'
          ? resolveModelSrcString(item, constants, `${childPath}[${i}]`)
          : item
      )
      continue
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (isModelConstantLike(value)) continue
      out[key] = walk(value as Record<string, unknown>, constants, childPath)
    }
  }
  return out
}

export function isModelSrcKey(key: string): boolean {
  return /Srcs?$/.test(key) || key === 'model_src'
}

function resolveModelSrcString(
  value: string,
  constants: Map<string, ModelConstant>,
  path: string
): string | ModelConstant {
  // Paths / URLs (registry://, s3://, ./rel, /abs, C:\…) — pass through.
  if (value.includes('/') || value.includes('\\') || value.startsWith('.')) {
    return value
  }

  const constant = constants.get(value)
  if (constant) return constant

  if (looksLikeConstantName(value)) {
    throw new Error(
      `${path}: unknown model constant "${value}". ` +
        'Use an SDK model constant name (e.g. TTS_S3GEN_EN_CHATTERBOX), ' +
        'a registry:// (or other) src URL, or a filesystem path.'
    )
  }

  // Bare filenames (e.g. `foo.gguf`) and other non-constant strings — leave
  // for the SDK / filesystem resolver.
  return value
}

function looksLikeConstantName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value)
}

function isModelConstantLike(value: object): boolean {
  return 'src' in value && 'name' in value && 'addon' in value
}
