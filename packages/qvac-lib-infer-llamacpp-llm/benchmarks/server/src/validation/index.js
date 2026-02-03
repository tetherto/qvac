'use strict'

const { z } = require('zod')

const InferenceArgsSchema = z.object({
  inputs: z.array(z.string()),
  lib: z.string().optional(), // Optional for P2P mode
  link: z.string().optional(),
  params: z.object({
    num_return_sequences: z.number().int() // todo: use enum for available modes
  }),
  opts: z.object({
    stats: z.boolean(),
    context_window_size: z.number().int(),
    prefill_chunk_size: z.number().int(),
    temperature: z.number(),
    max_tokens: z.number().int(),
    top_p: z.number(),
    do_sample: z.boolean(),
    system_message: z.string()
  }),
  config: z.object({}).optional(),
  // P2P model parameters
  hyperdriveKey: z.string().optional(),
  modelName: z.string().optional(),
  modelConfig: z.object({
    gpu_layers: z.string().optional(),
    ctx_size: z.string().optional(),
    temp: z.string().optional(),
    top_p: z.string().optional(),
    n_predict: z.string().optional(),
    system_prompt: z.string().optional()
  }).optional()
})

module.exports = {
  InferenceArgsSchema
}
