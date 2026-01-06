const { z } = require('zod')

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()),
  whisper: z.object({
    lib: z.string(),
    version: z.string().nullable().optional()
  }),
  link: z.string().optional(),
  vad: z.object({
    enabled: z.boolean(),
    lib: z.string().optional(),
    version: z.string().optional()
  }).refine(
    (data) => {
      if (data.enabled) {
        return data.lib && data.version
      }
      return true
    },
    {
      message: 'When VAD is enabled, both lib and version are required',
      path: ['vad']
    }
  ),
  params: z.object({
    modeParams: z.object({
      mode: z.string(), // todo: use enum for available modes
      updateFrequency: z.string(), // todo: use enum for available update frequencies
      outputFormat: z.string(), // todo: use enum for available output formats
      minSeconds: z.number(),
      maxSeconds: z.number()
    })
  }),
  opts: z.object({}).optional(),
  config: z.object({}).optional()
})

module.exports = {
  InferenceArgsSchema
}
