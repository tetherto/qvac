'use strict'

const { z } = require('zod')

// ---------------------------------------------------------------------------
// Whisper branch
// ---------------------------------------------------------------------------

const WhisperInferenceArgsSchema = z.object({
  engine: z.literal('whisper'),
  inputs: z.array(z.string()).min(1, 'At least one input is required'),
  whisper: z.object({
    lib: z.string(),
    version: z.string().nullable().optional()
  }),
  link: z.string().optional(),
  config: z.object({
    path: z.string(),
    whisperConfig: z.object({
      vad_model_path: z.string().optional(),
      language: z.string().optional(),
      audio_format: z.string().optional()
    }),
    sampleRate: z.number().optional(),
    streaming: z.boolean().optional(),
    streamingChunkSize: z.number().optional()
  }),
  opts: z.object({}).optional()
})

// ---------------------------------------------------------------------------
// Parakeet branch
// ---------------------------------------------------------------------------

const ParakeetConfigSchema = z.object({
  modelType: z.enum(['tdt', 'ctc', 'eou', 'sortformer']).optional().default('tdt'),
  maxThreads: z.number().int().positive().optional().default(4),
  useGPU: z.boolean().optional().default(false),
  captionEnabled: z.boolean().optional().default(false),
  timestampsEnabled: z.boolean().optional().default(true),
  seed: z.number().int().optional().default(-1)
})

const ParakeetRunConfigSchema = z.object({
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

const ParakeetInferenceArgsSchema = z.object({
  engine: z.literal('parakeet'),
  inputs: z.array(z.string()).min(1, 'At least one input is required'),
  parakeet: ParakeetSchema,
  config: ParakeetRunConfigSchema,
  opts: z.record(z.any()).optional()
})

// The POST /run body is discriminated on the required top-level `engine` key.
const InferenceArgsSchema = z.discriminatedUnion('engine', [
  WhisperInferenceArgsSchema,
  ParakeetInferenceArgsSchema
])

module.exports = {
  InferenceArgsSchema,
  WhisperInferenceArgsSchema,
  ParakeetInferenceArgsSchema,
  ParakeetRunConfigSchema,
  ParakeetConfigSchema,
  ParakeetSchema
}
