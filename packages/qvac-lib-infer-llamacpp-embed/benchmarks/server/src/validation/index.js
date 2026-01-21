'use strict'

const { z } = require('zod')

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()),
  config: z.object({
    // Model source (local or P2P)
    modelName: z.string().optional(),
    diskPath: z.string().optional().default('./models/'),
    hyperdriveKey: z.string().optional(), // P2P models
    // Inference parameters
    device: z.string().optional().default('gpu'),
    gpu_layers: z.string().optional().default('99'),
    ctx_size: z.string().optional().default('512'),
    batch_size: z.string().optional().default('2048'),
    verbosity: z.string().optional().default('0')
  }).optional()
})

module.exports = {
  InferenceArgsSchema
}
