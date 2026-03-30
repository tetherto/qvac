const { z } = require('zod')

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()),
  modelId: z.string(),
  hyperDriveKey: z.string(),
  params: z.object({
    srcLang: z.string(),
    dstLang: z.string()
  })
})

module.exports = {
  InferenceArgsSchema
}
