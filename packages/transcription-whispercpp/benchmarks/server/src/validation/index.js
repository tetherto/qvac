const { z } = require('zod')

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()),
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

module.exports = {
  InferenceArgsSchema
}
