import { z } from "zod";
import { modelSrcInputSchema } from "./model-src-utils";

// Bergamot supports many more language pairs
export const BERGAMOT_LANGUAGES = [
  "en",
  "ar",
  "bg",
  "ca",
  "cs",
  "de",
  "es",
  "et",
  "fi",
  "fr",
  "hu",
  "is",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "nl",
  "pl",
  "pt",
  "ru",
  "sk",
  "sl",
  "uk",
  "zh",
  "az",
  "be",
  "bn",
  "bs",
  "da",
  "el",
  "fa",
  "gu",
  "he",
  "hi",
  "hr",
  "id",
  "kn",
  "ml",
  "ms",
  "mt",
  "nb",
  "nn",
  "re",
  "ro",
  "sq",
  "sr",
  "sv",
  "ta",
  "te",
  "tr",
  "vi",
] as const;

// IndicTrans2 model languages
export const INDICTRANS_LANGUAGES = [
  "asm_Beng", // Assamese
  "ben_Beng", // Bengali
  "brx_Deva", // Bodo
  "doi_Deva", // Dogri
  "eng_Latn", // English
  "gom_Deva", // Konkani
  "guj_Gujr", // Gujarati
  "hin_Deva", // Hindi
  "kan_Knda", // Kannada
  "kas_Arab", // Kashmiri (Arabic)
  "kas_Deva", // Kashmiri (Devanagari)
  "mai_Deva", // Maithili
  "mal_Mlym", // Malayalam
  "mar_Deva", // Marathi
  "mni_Beng", // Manipuri (Bengali)
  "mni_Mtei", // Manipuri (Meitei)
  "npi_Deva", // Nepali
  "ory_Orya", // Odia
  "pan_Guru", // Punjabi
  "san_Deva", // Sanskrit
  "sat_Olck", // Santali
  "snd_Arab", // Sindhi (Arabic)
  "snd_Deva", // Sindhi (Devanagari)
  "tam_Taml", // Tamil
  "tel_Telu", // Telugu
  "urd_Arab", // Urdu
] as const;

export const AFRICAN_LANGUAGES_MAP = new Map([
  ["afr_Latn", "Afrikaans"],
  ["swh_Latn", "Swahili"],
  ["ary_Arab", "Moroccan Arabic"],
  ["som_Latn", "Somali"],
  ["amh_Ethi", "Amharic"],
  ["arz_Arab", "Egyptian Arabic"],
  ["hau_Latn", "Hausa"],
  ["kin_Latn", "Kinyarwanda"],
  ["zul_Latn", "Zulu"],
  ["ibo_Latn", "Igbo"],
  ["plt_Latn", "Plateau Malagasy"],
  ["xho_Latn", "Xhosa"],
  ["sna_Latn", "Shona"],
  ["yor_Latn", "Yoruba"],
  ["nya_Latn", "Nyanja"],
  ["sot_Latn", "Southern Sotho"],
  ["tir_Ethi", "Tigrinya"],
  ["aeb_Arab", "Tunisian Arabic"],
  ["gaz_Latn", "Oromo"],
  ["tsn_Latn", "Tswana"],
]);

// Union of all NMT languages (for general type usage)
export const NMT_LANGUAGES = [
  ...BERGAMOT_LANGUAGES,
  ...INDICTRANS_LANGUAGES,
] as const;

export const NMT_ENGINES = ["Bergamot", "IndicTrans"] as const;
export type NmtEngine = (typeof NMT_ENGINES)[number];

// Common generation parameters (without language fields)
const nmtGenerationParamsSchema = z.object({
  mode: z.enum(["full"]).optional(),
  beamsize: z.number().optional(),
  lengthpenalty: z.number().optional(),
  maxlength: z.number().optional(),
  repetitionpenalty: z.number().optional(),
  norepeatngramsize: z.number().optional(),
  temperature: z.number().optional(),
  topk: z.number().optional(),
  topp: z.number().optional(),
});

// Pivot model configuration for Bergamot (for translation via intermediate language)
const bergamotPivotModelSchema = nmtGenerationParamsSchema
  .extend({
    modelSrc: modelSrcInputSchema,
    srcVocabSrc: modelSrcInputSchema.optional(),
    dstVocabSrc: modelSrcInputSchema.optional(),
    normalize: z.number().optional(),
  })
  .optional();

// Bergamot engine config - supports BERGAMOT_LANGUAGES
const bergamotConfigSchema = nmtGenerationParamsSchema.extend({
  engine: z.literal("Bergamot"),
  from: z.enum(BERGAMOT_LANGUAGES),
  to: z.enum(BERGAMOT_LANGUAGES),
  srcVocabSrc: modelSrcInputSchema.optional(),
  dstVocabSrc: modelSrcInputSchema.optional(),
  normalize: z.number().optional(),
  pivotModel: bergamotPivotModelSchema,
});

// IndicTrans engine config - supports INDICTRANS_LANGUAGES
const indicTransConfigSchema = nmtGenerationParamsSchema.extend({
  engine: z.literal("IndicTrans"),
  from: z.enum(INDICTRANS_LANGUAGES),
  to: z.enum(INDICTRANS_LANGUAGES),
});

// Discriminated union of all engine configs
export const nmtConfigBaseSchema = z.discriminatedUnion("engine", [
  bergamotConfigSchema,
  indicTransConfigSchema,
]);

// Apply defaults via transform
export const nmtConfigSchema = nmtConfigBaseSchema.transform((data) => ({
  ...data,
  mode: data.mode ?? "full",
  beamsize: data.beamsize ?? 4,
  lengthpenalty: data.lengthpenalty ?? 1.0,
  maxlength: data.maxlength ?? 512,
  repetitionpenalty: data.repetitionpenalty ?? 1.0,
  norepeatngramsize: data.norepeatngramsize ?? 0,
  temperature: data.temperature ?? 0.3,
  topk: data.topk ?? 0,
  topp: data.topp ?? 1.0,
}));

export type BergamotLanguage = (typeof BERGAMOT_LANGUAGES)[number];
export type IndicTransLanguage = (typeof INDICTRANS_LANGUAGES)[number];
export type NmtLanguage = (typeof NMT_LANGUAGES)[number];
export type NmtConfig = z.infer<typeof nmtConfigSchema>;
