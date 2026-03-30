'use strict'

const { z } = require('zod')

const ParakeetConfigSchema = z.object({
  modelType: z.enum(['tdt', 'ctc', 'eou', 'sortformer']).optional().default('tdt'),
  maxThreads: z.number().int().positive().optional().default(4),
  useGPU: z.boolean().optional().default(false),
  captionEnabled: z.boolean().optional().default(false),
  timestampsEnabled: z.boolean().optional().default(true),
  seed: z.number().int().optional().default(-1)
})

const ConfigSchema = z.object({
  path: z.string().min(1, 'Model path is required'),
  parakeetConfig: ParakeetConfigSchema.optional(),
  sampleRate: z.number().int().positive().optional().default(16000),
  streaming: z.boolean().optional().default(false),
  streamingChunkSize: z.number().int().positive().optional().default(16384)
})

const ParakeetSchema = z.object({
  lib: z.string().min(1, 'Parakeet library name is required'),
  version: z.string().optional()
})

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()).min(1, 'At least one input is required'),
  parakeet: ParakeetSchema,
  config: ConfigSchema,
  opts: z.record(z.any()).optional()
})

module.exports = {
  InferenceArgsSchema,
  ConfigSchema,
  ParakeetConfigSchema,
  ParakeetSchema
}
