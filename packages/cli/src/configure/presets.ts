// Curated modality metadata, recommended defaults, and the pure functions that
// turn a chosen model (or a template) into a serve.models entry. No prompts and
// no SDK RPCs here — this is the testable core the interactive layer (and, later,
// an LLM advisor) feeds.

export type Modality = 'chat' | 'embedding' | 'transcription' | 'speech' | 'image'

export interface ServeModelEntry {
  model?: string
  src?: string
  type?: string
  preload?: boolean
  config?: Record<string, unknown>
}

export interface BuiltEntry {
  /** Basis for the alias (a constant name); the caller kebabs + dedupes it. */
  aliasBase: string
  entry: ServeModelEntry
  /** SDK addon, for resolving the docs link. */
  addon: string
}

export interface ModalityInfo {
  id: Modality
  label: string
  /** endpointCategory used to filter the catalog. */
  role: string
  addon: string
  /** true → user searches/picks a real constant; false → fixed template. */
  pick: boolean
}

export const MODALITIES: ModalityInfo[] = [
  { id: 'chat', label: 'Chat (LLM)', role: 'chat', addon: 'llm', pick: true },
  { id: 'embedding', label: 'Embedding', role: 'embedding', addon: 'embeddings', pick: true },
  {
    id: 'transcription',
    label: 'Speech-to-text (transcription)',
    role: 'transcription',
    addon: 'whisper',
    pick: true
  },
  { id: 'image', label: 'Image generation', role: 'image', addon: 'diffusion', pick: true },
  { id: 'speech', label: 'Text-to-speech', role: 'speech', addon: 'tts', pick: false }
]

export function modalityInfo(id: Modality): ModalityInfo {
  const info = MODALITIES.find((m) => m.id === id)
  if (!info) throw new Error(`Unknown modality "${id}"`)
  return info
}

/** Curated recommended constant per pick-able modality (smallest well-known). */
export const RECOMMENDED: Partial<Record<Modality, string>> = {
  chat: 'QWEN3_600M_INST_Q4',
  embedding: 'EMBEDDINGGEMMA_300M_Q4_0',
  transcription: 'WHISPER_TINY_Q8_0',
  image: 'SD_V2_1_1B_Q8_0'
}

/** Non-interactive `--yes` default: ≥2 modalities, both fully runnable. */
export const DEFAULT_STARTER: Modality[] = ['chat', 'transcription']

// A best-effort TTS example. TTS is an assembly (no single-artifact constant),
// and the voice is a user asset — so this ships with a placeholder voice path
// and relies on the docs link to finish. Not guaranteed to run untouched.
export const TTS_VOICE_PLACEHOLDER = '/path/to/voice.wav'

export type TtsEngine = 'chatterbox' | 'supertonic' | 'parler' | 'cosyvoice3' | 'audio8'

interface TtsEngineTemplate {
  label: string
  /** Shown under the choice in the picker. */
  hint: string
  /** Primary model constant (serve resolves the name). */
  model: string
  /** modelConfig; each engine's required + example-recommended fields. */
  config: Record<string, unknown>
}

// One starter per TTS engine, mirroring the runnable examples in
// packages/sdk/examples/tts. TTS is a multi-part assembly, so each template
// pre-populates the engine's required auxiliary sources (schema-optional but
// needed to actually run) — chatterbox's S3Gen, audio8's codec decoder — that a
// bare model pick can't supply. Voice cloning stays a user asset (placeholder).
export const TTS_ENGINE_TEMPLATES: Record<TtsEngine, TtsEngineTemplate> = {
  chatterbox: {
    label: 'Chatterbox (English, voice cloning)',
    hint: 'T3 + S3Gen; set referenceAudioSrc to clone a voice.',
    model: 'TTS_T3_TURBO_EN_CHATTERBOX_Q8_0',
    config: {
      ttsEngine: 'chatterbox',
      language: 'en',
      s3genModelSrc: 'TTS_S3GEN_EN_CHATTERBOX',
      referenceAudioSrc: TTS_VOICE_PLACEHOLDER
    }
  },
  supertonic: {
    label: 'Supertonic (multilingual, lightweight)',
    hint: 'Single-model; fast, no auxiliary sources required.',
    model: 'TTS_MULTILINGUAL_SUPERTONIC3_Q8_0',
    config: { ttsEngine: 'supertonic', language: 'en' }
  },
  parler: {
    label: 'Parler (English, prompt-styled)',
    hint: 'Single-model; describe the voice via the request.',
    model: 'TTS_MINI_V1_EN_PARLER_TTS_Q8_0',
    config: { ttsEngine: 'parler' }
  },
  cosyvoice3: {
    label: 'CosyVoice3 (multilingual)',
    hint: 'LLM GGUF; flow/HiFT/voice load from its co-located companion set.',
    model: 'TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0',
    config: { ttsEngine: 'cosyvoice3' }
  },
  audio8: {
    label: 'Audio8 (multilingual, voice cloning)',
    hint: 'DualAR LM + codec decoder; add the encoder to clone a voice.',
    model: 'TTS_LM_MULTILINGUAL_AUDIO8_Q8_0',
    config: {
      ttsEngine: 'audio8',
      audio8CodecDecoderModelSrc: 'TTS_CODEC_DECODER_AUDIO8_Q8_0'
    }
  }
}

export const TTS_ENGINES = Object.keys(TTS_ENGINE_TEMPLATES) as TtsEngine[]

function ttsTemplate(engine: TtsEngine): BuiltEntry {
  const t = TTS_ENGINE_TEMPLATES[engine]
  return {
    aliasBase: t.model,
    addon: 'tts',
    entry: { type: 'tts', src: t.model, preload: false, config: { ...t.config } }
  }
}

/** Build a serve.models entry for a modality. For pick-able modalities pass the
 * chosen constant name; for `speech` pass the chosen TTS engine (defaults to
 * chatterbox). */
export function buildEntry(modality: Modality, constantName?: string): BuiltEntry {
  const info = modalityInfo(modality)
  if (modality === 'speech') {
    const engine = (constantName as TtsEngine | undefined) ?? 'chatterbox'
    return ttsTemplate(engine)
  }

  const name = constantName ?? RECOMMENDED[modality]
  if (!name) throw new Error(`No model chosen and no recommended default for "${modality}"`)

  const entry: ServeModelEntry = { model: name, preload: false }
  if (modality === 'image') entry.config = { prediction: 'v' }
  return { aliasBase: name, entry, addon: info.addon }
}

/** Generic entry for a model picked via "search all" (no modality-specific
 * config). `addon` drives the docs link. */
export function buildGenericEntry(constantName: string, addon: string | null): BuiltEntry {
  return {
    aliasBase: constantName,
    entry: { model: constantName, preload: false },
    addon: addon ?? ''
  }
}

export interface AddedEntry {
  alias: string
  addon: string
  entry: ServeModelEntry
}

/** Turn modality selections into aliased serve.models additions, deduping
 * aliases against `taken` (mutated as it goes). Used by the non-interactive path. */
export function buildAdditions(
  selections: Array<{ modality: Modality; constantName?: string }>,
  taken: Set<string>
): AddedEntry[] {
  const out: AddedEntry[] = []
  for (const sel of selections) {
    const built = buildEntry(sel.modality, sel.constantName)
    const alias = aliasFor(built.aliasBase, taken)
    taken.add(alias)
    out.push({ alias, addon: built.addon, entry: built.entry })
  }
  return out
}

/** Kebab-case a constant name into an alias, deduped against `taken`. */
export function aliasFor(base: string, taken: Set<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model'
  if (!taken.has(slug)) return slug
  let n = 2
  while (taken.has(`${slug}-${n}`)) n++
  return `${slug}-${n}`
}
