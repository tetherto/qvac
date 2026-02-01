import { z } from "zod";

// Marian model languages
const MARIAN_LANGUAGES = ["en", "de", "es", "it", "ru", "ja"] as const;

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

export const NMT_LANGUAGES = [
  ...MARIAN_LANGUAGES,
  ...INDICTRANS_LANGUAGES,
] as const;

export const nmtConfigBaseSchema = z.object({
  mode: z.enum(["full"]).optional(),
  from: z.enum(NMT_LANGUAGES),
  to: z.enum(NMT_LANGUAGES),
  // Generation parameters (lowercase to match addon expectations)
  beamsize: z.number().optional(),
  lengthpenalty: z.number().optional(),
  maxlength: z.number().optional(),
  repetitionpenalty: z.number().optional(),
  norepeatngramsize: z.number().optional(),
  temperature: z.number().optional(),
  topk: z.number().optional(),
  topp: z.number().optional(),
});

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

export type NmtLanguage = (typeof NMT_LANGUAGES)[number];
export type NmtConfig = z.infer<typeof nmtConfigSchema>;
