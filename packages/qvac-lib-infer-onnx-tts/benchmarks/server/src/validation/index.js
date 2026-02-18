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

module.exports = {
  ChatterboxConfigSchema,
  ChatterboxRequestSchema
}
