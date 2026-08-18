import { z } from 'zod'
import { ModelType } from './model-types'
import { VERBOSITY } from './llamacpp-config'
import {
  PLUGIN_LLM,
  PLUGIN_EMBEDDING,
  PLUGIN_WHISPER,
  PLUGIN_BCI,
  PLUGIN_NMT,
  PLUGIN_TTS,
  PLUGIN_OCR,
  PLUGIN_DIFFUSION,
  PLUGIN_AUDIOGEN,
  PLUGIN_VLA,
  PLUGIN_CLASSIFICATION
} from './plugin'
import { SUPPORTED_AUDIO_FORMATS } from '@/constants/audio'
import { AUDIOGEN_TASK_TYPES } from './audio-gen'
import {
  TTS_PACES,
  TTS_COSYVOICE3_EMOTIONS,
  TTS_COSYVOICE3_INSTRUCT_DIALECTS,
  TTS_COSYVOICE3_INSTRUCT_VOLUMES,
  TTS_COSYVOICE3_INSTRUCT_STYLES
} from './text-to-speech'

// Uppercases each vocabulary value into an identifier-safe varname (e.g.
// 'slow' -> 'SLOW', 'cover-nofsq' -> 'COVER_NOFSQ'), mirroring the
// SupportedAudioFormat derivation so names can't drift from the single
// source-of-truth array.
function enumFromVocabulary<const T extends readonly string[]>(values: T) {
  return z.enum(
    Object.fromEntries(values.map((value) => [value.toUpperCase().replace(/-/g, '_'), value]))
  )
}

/**
 * Every public constant `enum` from index.ts that downstream (non-JS)
 * client generators should get as a real, named type instead of a
 * hardcoded string/number. `build-contract.ts` merges each of these
 * directly into `schema.json`'s `$defs` (same `z.toJSONSchema` call, same
 * generator run as every request/response type), tagged with an
 * `x-enum-varnames` hint so datamodel-code-generator preserves the
 * original key names instead of slugging them from the bare value — plain
 * JSON Schema `enum:` only carries values, not names, so without that hint
 * `PluginId`/`Verbosity` (whose keys aren't derivable from their values)
 * would lose their names entirely.
 *
 * A constant only reaches other languages if it's registered here. See
 * `.cursor/rules/sdk/public-constants-contract.mdc`: any new public
 * constant meant for downstream SDKs must be a `z.enum(...)` added here,
 * not just a bare `export const` in its own schema file — otherwise it
 * silently never leaves JS.
 *
 * Scoped to name→value maps (`z.enum`) only. A standalone scalar constant
 * (e.g. `VLA_DEFAULT_IMAGE_SIZE`) has no natural JSON Schema representation
 * as a plain value — a `const`-only schema generates an awkward
 * `RootModel[Literal[...]]` wrapper class in Python, not a usable
 * constant — so scalars aren't covered by this registry.
 */
export const constantsRegistry = {
  ModelType: z.enum(ModelType),
  Verbosity: z.enum(VERBOSITY),
  PluginId: z.enum({
    LLM: PLUGIN_LLM,
    EMBEDDING: PLUGIN_EMBEDDING,
    WHISPER: PLUGIN_WHISPER,
    BCI: PLUGIN_BCI,
    NMT: PLUGIN_NMT,
    TTS: PLUGIN_TTS,
    OCR: PLUGIN_OCR,
    DIFFUSION: PLUGIN_DIFFUSION,
    AUDIOGEN: PLUGIN_AUDIOGEN,
    VLA: PLUGIN_VLA,
    CLASSIFICATION: PLUGIN_CLASSIFICATION
  }),
  // Derived from SUPPORTED_AUDIO_FORMATS itself (e.g. '.mp3' -> 'MP3') rather
  // than a hand-written record, so the varnames can't drift from the one
  // source of truth every other consumer of SUPPORTED_AUDIO_FORMATS shares.
  SupportedAudioFormat: z.enum(
    Object.fromEntries(SUPPORTED_AUDIO_FORMATS.map((ext) => [ext.slice(1).toUpperCase(), ext]))
  ),
  TtsPace: enumFromVocabulary(TTS_PACES),
  TtsCosyvoice3Emotion: enumFromVocabulary(TTS_COSYVOICE3_EMOTIONS),
  TtsCosyvoice3InstructDialect: enumFromVocabulary(TTS_COSYVOICE3_INSTRUCT_DIALECTS),
  TtsCosyvoice3InstructVolume: enumFromVocabulary(TTS_COSYVOICE3_INSTRUCT_VOLUMES),
  TtsCosyvoice3InstructStyle: enumFromVocabulary(TTS_COSYVOICE3_INSTRUCT_STYLES),
  AudioGenTaskType: enumFromVocabulary(AUDIOGEN_TASK_TYPES)
} as const
