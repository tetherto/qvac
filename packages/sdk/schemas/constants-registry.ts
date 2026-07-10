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
import { VLA_DEFAULT_IMAGE_SIZE } from '@/client/api/vla-helpers'
import { SUPPORTED_AUDIO_FORMATS } from '@/constants/audio'

/**
 * Every public constant from index.ts that downstream (non-JS) client
 * generators should get as a typed, named value instead of a hardcoded
 * string/number — the registry `build-constants-registry.ts` walks to
 * produce `contract/constants.json`.
 *
 * A constant only reaches other languages if it's registered here. See
 * `.cursor/rules/sdk/public-constants-contract.mdc`: any new public constant
 * meant for downstream SDKs must be a `z.enum(...)`/`z.literal(...)` added to
 * one of these two maps, not just a bare `export const` in its own schema
 * file — otherwise it silently never leaves JS.
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

export const scalarConstantsRegistry = {
  VlaDefaultImageSize: z.literal(VLA_DEFAULT_IMAGE_SIZE)
} as const
