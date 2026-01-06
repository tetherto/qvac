'use strict'

const { z } = require('zod')

const TTSConfigSchema = z.object({
  modelPath: z.string(),
  configPath: z.string(),
  eSpeakDataPath: z.string().optional(),
  language: z.string().default('en'),
  sampleRate: z.number().int().positive().default(22050),
  useGPU: z.boolean().optional().default(false)
})

const TTSRequestSchema = z.object({
  texts: z.array(z.string()).min(1),
  config: TTSConfigSchema,
  includeSamples: z.boolean().optional().default(false)
})

module.exports = {
  TTSConfigSchema,
  TTSRequestSchema
}
