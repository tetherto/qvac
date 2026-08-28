import { z } from 'zod'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'

// Bergamot supports many more language pairs
export const BERGAMOT_LANGUAGES = [
  'en',
  'ar',
  'bg',
  'ca',
  'cs',
  'de',
  'es',
  'et',
  'fi',
  'fr',
  'hu',
  'is',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'nl',
  'pl',
  'pt',
  'ru',
  'sk',
  'sl',
  'uk',
  'zh',
  'az',
  'be',
  'bn',
  'bs',
  'da',
  'el',
  'fa',
  'gu',
  'he',
  'hi',
  'hr',
  'id',
  'kn',
  'ml',
  'ms',
  'mt',
  'nb',
  'nn',
  'no',
  're',
  'ro',
  'sq',
  'sr',
  'sv',
  'ta',
  'te',
  'th',
  'tr',
  'vi'
] as const

export const BERGAMOT_MODEL_RE = /^(.+\/)model\.([a-z]+)\.intgemm\.alphas\.bin$/

export const BERGAMOT_CJK_LANG_PAIRS: readonly string[] = ['enja', 'enko', 'enzh']

// IndicTrans2 model languages
export const INDICTRANS_LANGUAGES = [
  'asm_Beng', // Assamese
  'ben_Beng', // Bengali
  'brx_Deva', // Bodo
  'doi_Deva', // Dogri
  'eng_Latn', // English
  'gom_Deva', // Konkani
  'guj_Gujr', // Gujarati
  'hin_Deva', // Hindi
  'kan_Knda', // Kannada
  'kas_Arab', // Kashmiri (Arabic)
  'kas_Deva', // Kashmiri (Devanagari)
  'mai_Deva', // Maithili
  'mal_Mlym', // Malayalam
  'mar_Deva', // Marathi
  'mni_Beng', // Manipuri (Bengali)
  'mni_Mtei', // Manipuri (Meitei)
  'npi_Deva', // Nepali
  'ory_Orya', // Odia
  'pan_Guru', // Punjabi
  'san_Deva', // Sanskrit
  'sat_Olck', // Santali
  'snd_Arab', // Sindhi (Arabic)
  'snd_Deva', // Sindhi (Devanagari)
  'tam_Taml', // Tamil
  'tel_Telu', // Telugu
  'urd_Arab' // Urdu
] as const

export const AFRICAN_LANGUAGES_MAP = new Map([
  ['afr_Latn', 'Afrikaans'],
  ['swh_Latn', 'Swahili'],
  ['ary_Arab', 'Moroccan Arabic'],
  ['som_Latn', 'Somali'],
  ['amh_Ethi', 'Amharic'],
  ['arz_Arab', 'Egyptian Arabic'],
  ['hau_Latn', 'Hausa'],
  ['kin_Latn', 'Kinyarwanda'],
  ['zul_Latn', 'Zulu'],
  ['ibo_Latn', 'Igbo'],
  ['plt_Latn', 'Plateau Malagasy'],
  ['xho_Latn', 'Xhosa'],
  ['sna_Latn', 'Shona'],
  ['yor_Latn', 'Yoruba'],
  ['nya_Latn', 'Nyanja'],
  ['sot_Latn', 'Southern Sotho'],
  ['tir_Ethi', 'Tigrinya'],
  ['aeb_Arab', 'Tunisian Arabic'],
  ['gaz_Latn', 'Oromo'],
  ['tsn_Latn', 'Tswana']
])

// Union of all NMT languages (for general type usage)
export const NMT_LANGUAGES = [...BERGAMOT_LANGUAGES, ...INDICTRANS_LANGUAGES] as const

export const NMT_ENGINES = ['Bergamot', 'IndicTrans'] as const
export type NmtEngine = (typeof NMT_ENGINES)[number]

// Common generation parameters (without language fields). Full effect on
// IndicTrans2; Bergamot has limited generation-parameter support.
const nmtGenerationParamsSchema = z.object({
  mode: z
    .enum(['full'])
    .optional()
    .describe("Generation mode; currently only `'full'` is supported. Default `'full'`."),
  beamsize: z
    .number()
    .optional()
    .describe('Beam search width (≥1); 1 disables beam search. Default 4.'),
  lengthpenalty: z.number().optional().describe('Length-normalization strength (≥0). Default 1.0.'),
  maxlength: z.number().optional().describe('Maximum generated tokens (>0). Default 512.'),
  repetitionpenalty: z
    .number()
    .optional()
    .describe('Penalty on previously generated tokens (0–2). Default 1.0.'),
  norepeatngramsize: z
    .number()
    .optional()
    .describe('Disallow repeating n-grams of this size (0–10); 0 disables. Default 0.'),
  temperature: z.number().optional().describe('Sampling temperature (0–2). Default 0.3.'),
  topk: z.number().optional().describe('Keep top-K logits (0–vocab_size); 0 disables. Default 0.'),
  topp: z.number().optional().describe('Nucleus-sampling threshold (0 < p ≤ 1). Default 1.0.')
})

// Pivot model configuration for Bergamot (for translation via intermediate language)
const bergamotPivotModelSchema = nmtGenerationParamsSchema
  .extend({
    modelSrc: modelSrcInputSchema.describe('Second-stage (pivot) translation model source.'),
    srcVocabSrc: modelSrcInputSchema
      .optional()
      .describe('Pivot model source-language vocabulary file source.'),
    dstVocabSrc: modelSrcInputSchema
      .optional()
      .describe('Pivot model target-language vocabulary file source.'),
    normalize: z
      .number()
      .optional()
      .describe('Pivot model input normalization: 1 = on (default), 0 = off.')
  })
  .optional()

// Bergamot engine config - supports BERGAMOT_LANGUAGES
const bergamotConfigSchema = nmtGenerationParamsSchema.extend({
  engine: z
    .literal('Bergamot')
    .describe('Translation backend: Bergamot — fast bilingual models keyed by ISO 639-1 codes.'),
  from: z.enum(BERGAMOT_LANGUAGES).describe('Source language (ISO 639-1, e.g. `en`).'),
  to: z.enum(BERGAMOT_LANGUAGES).describe('Target language (ISO 639-1, e.g. `de`).'),
  srcVocabSrc: modelSrcInputSchema
    .optional()
    .describe('Source-language vocabulary file source (required for Bergamot).'),
  dstVocabSrc: modelSrcInputSchema
    .optional()
    .describe('Target-language vocabulary file source (required for Bergamot).'),
  normalize: z.number().optional().describe('Input normalization: 1 = on (default), 0 = off.'),
  pivotModel: bergamotPivotModelSchema.describe(
    'Optional second-stage model for pivot translation (translate via an intermediate language).'
  )
})

// IndicTrans engine config - supports INDICTRANS_LANGUAGES
const indicTransConfigSchema = nmtGenerationParamsSchema.extend({
  engine: z
    .literal('IndicTrans')
    .describe(
      'Translation backend: IndicTrans2 — keyed by ISO 15924 codes; full generation-parameter support.'
    ),
  from: z.enum(INDICTRANS_LANGUAGES).describe('Source language (ISO 15924, e.g. `hin_Deva`).'),
  to: z.enum(INDICTRANS_LANGUAGES).describe('Target language (ISO 15924, e.g. `eng_Latn`).')
})

// Discriminated union of all engine configs
export const nmtConfigBaseSchema = z.discriminatedUnion('engine', [
  bergamotConfigSchema,
  indicTransConfigSchema
])

// Apply defaults via transform
export const nmtConfigSchema = nmtConfigBaseSchema.transform((data) => ({
  ...data,
  mode: data.mode ?? 'full',
  beamsize: data.beamsize ?? 4,
  lengthpenalty: data.lengthpenalty ?? 1.0,
  maxlength: data.maxlength ?? 512,
  repetitionpenalty: data.repetitionpenalty ?? 1.0,
  norepeatngramsize: data.norepeatngramsize ?? 0,
  temperature: data.temperature ?? 0.3,
  topk: data.topk ?? 0,
  topp: data.topp ?? 1.0
}))

export type BergamotLanguage = (typeof BERGAMOT_LANGUAGES)[number]
export type IndicTransLanguage = (typeof INDICTRANS_LANGUAGES)[number]
export type NmtLanguage = (typeof NMT_LANGUAGES)[number]
export type NmtConfig = z.infer<typeof nmtConfigSchema>
