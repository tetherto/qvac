'use strict'

const { z } = require('zod')

const ChatterboxConfigSchema = z.object({
  modelDir: z.string().optional(),
  tokenizerPath: z.string().optional(),
  speechEncoderPath: z.string().optional(),
  embedTokensPath: z.string().optional(),
  conditionalDecoderPath: z.string().optional(),
  languageModelPath: z.string().optional(),
  useSyntheticAudio: z.boolean().optional().default(true),
  language: z.string().default('en'),
  sampleRate: z.number().int().positive().default(24000),
  useGPU: z.boolean().optional().default(false),
  variant: z.string().optional().default('fp32')
})

const ChatterboxRequestSchema = z.object({
  texts: z.array(z.string()).min(1),
  config: ChatterboxConfigSchema,
  includeSamples: z.boolean().optional().default(false)
})

const SupertonicConfigSchema = z.object({
  modelDir: z.string().optional(),
  voiceName: z.string().optional().default('F1'),
  language: z.string().default('en'),
  sampleRate: z.number().int().positive().default(44100),
  speed: z.number().optional().default(1),
  numInferenceSteps: z.number().int().min(1).optional().default(5),
  /** Supertone `<lang>…</lang>` preprocessing. Benchmark defaults false (English-only); set true for multilingual text. */
  supertonicMultilingual: z.boolean().optional().default(false),
  useGPU: z.boolean().optional().default(false)
})

const SupertonicRequestSchema = z.object({
  texts: z.array(z.string()).min(1),
  config: SupertonicConfigSchema,
  includeSamples: z.boolean().optional().default(false)
})

module.exports = {
  ChatterboxConfigSchema,
  ChatterboxRequestSchema,
  SupertonicConfigSchema,
  SupertonicRequestSchema
}
