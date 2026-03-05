import { z } from "zod";

// Marian/Opus model languages
export const MARIAN_LANGUAGES = ["en", "de", "es", "it", "ru", "ja"] as const;

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

// Union of all NMT languages (for general type usage)
export const NMT_LANGUAGES = [
  ...MARIAN_LANGUAGES,
  ...BERGAMOT_LANGUAGES,
  ...INDICTRANS_LANGUAGES,
] as const;

export const NMT_ENGINES = ["Opus", "Bergamot", "IndicTrans"] as const;
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

// Opus engine config (Marian-based) - supports MARIAN_LANGUAGES
const opusConfigSchema = nmtGenerationParamsSchema.extend({
  engine: z.literal("Opus"),
  from: z.enum(MARIAN_LANGUAGES),
  to: z.enum(MARIAN_LANGUAGES),
});

// Bergamot engine config - supports BERGAMOT_LANGUAGES
const bergamotConfigSchema = nmtGenerationParamsSchema.extend({
  engine: z.literal("Bergamot"),
  from: z.enum(BERGAMOT_LANGUAGES),
  to: z.enum(BERGAMOT_LANGUAGES),
  srcVocabPath: z.string().optional(),
  dstVocabPath: z.string().optional(),
  normalize: z.number().optional(),
});

// IndicTrans engine config - supports INDICTRANS_LANGUAGES
const indicTransConfigSchema = nmtGenerationParamsSchema.extend({
  engine: z.literal("IndicTrans"),
  from: z.enum(INDICTRANS_LANGUAGES),
  to: z.enum(INDICTRANS_LANGUAGES),
});

// Discriminated union of all engine configs
export const nmtConfigBaseSchema = z.discriminatedUnion("engine", [
  opusConfigSchema,
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

export type MarianLanguage = (typeof MARIAN_LANGUAGES)[number];
export type BergamotLanguage = (typeof BERGAMOT_LANGUAGES)[number];
export type IndicTransLanguage = (typeof INDICTRANS_LANGUAGES)[number];
export type NmtLanguage = (typeof NMT_LANGUAGES)[number];
export type NmtConfig = z.infer<typeof nmtConfigSchema>;
