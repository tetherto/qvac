const { z } = require('zod')

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()),
  lib: z.string(),
  version: z.string().nullable().optional(),
  params: z.object({}).optional(),
  opts: z.object({}).optional(),
  config: z.object({}).optional()
})

module.exports = {
  InferenceArgsSchema
}
