'use strict'

const { z } = require('zod')

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()),
  config: z.object({
    // Model source (local or P2P)
    modelName: z.string().optional(),
    diskPath: z.string().optional(), // Local GGUF models
    hyperdriveKey: z.string().optional(), // P2P models
    // Inference parameters
    device: z.string().optional(),
    gpu_layers: z.string().optional(),
    ctx_size: z.string().optional(),
    temp: z.string().optional(),
    top_p: z.string().optional(),
    top_k: z.string().optional(),
    n_predict: z.string().optional(),
    repeat_penalty: z.string().optional(),
    seed: z.string().optional()
  }).optional(),
  // System prompt for guiding model behavior
  systemPrompt: z.string().optional()
})

module.exports = {
  InferenceArgsSchema
}
