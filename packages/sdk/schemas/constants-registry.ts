import { z } from 'zod'
import { ModelType } from './model-types'
import { TOOLS_MODE } from './tools'
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
  PLUGIN_VLA,
  PLUGIN_CLASSIFICATION
} from './plugin'
import { SUPPORTED_AUDIO_FORMATS } from '@/constants/audio'

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
  ToolsMode: z.enum(TOOLS_MODE),
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
    VLA: PLUGIN_VLA,
    CLASSIFICATION: PLUGIN_CLASSIFICATION
  }),
  SupportedAudioFormat: z.enum(SUPPORTED_AUDIO_FORMATS)
} as const
