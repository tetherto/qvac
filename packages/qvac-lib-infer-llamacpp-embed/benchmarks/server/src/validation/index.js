const { z } = require('zod')

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()),
  lib: z.string(),
  version: z.string().optional(),
  link: z.string().optional(),
  params: z.object({}).optional(),
  opts: z.object({}).optional(),
  config: z.object({
    // Note: Path validation intentionally minimal for benchmark environment
    modelFilePath: z.string().optional(),
    addonConfig: z.string().optional()
  }).optional()
})

module.exports = {
  InferenceArgsSchema
}
