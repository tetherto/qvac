import { z } from 'zod'
import { definePlugin, defineHandler } from '@qvac/sdk'

const echoRequestSchema = z.object({
  message: z.string()
})

const echoResponseSchema = z.object({
  message: z.string()
})

const echoStreamChunkSchema = z.object({
  chunk: z.string()
})

const videoStreamRequestSchema = z
  .object({
    type: z.literal('videoStream'),
    modelId: z.string().min(1),
    requestId: z.string().min(1),
    mode: z.literal('txt2vid'),
    prompt: z.string().min(1),
    lora: z.string().regex(/^(?:\/|[A-Za-z]:[\\/])/, {
      message: 'lora must be an absolute path'
    }),
    lora_strength: z.number().min(0).max(10),
    stg_scale: z.number().min(0).max(10),
    stg_block: z.number().int().nonnegative(),
    reference_images: z.union([z.tuple([z.literal('AQID')]), z.tuple([z.literal('AA==')])]),
    reference_attention_strength: z.number().min(0).max(1),
    reference_downscale_factor: z.literal(1),
    video_frames: z.literal(121),
    scheduler: z.literal('ltx2')
  })
  .strict()
  .superRefine((request, ctx) => {
    const expectedReference = request.lora_strength === 0 ? 'AA==' : 'AQID'
    if (request.reference_images[0] !== expectedReference) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference_images', 0],
        message: `expected exact reference image base64 ${expectedReference}`
      })
    }
  })

const videoStreamResponseSchema = z.object({
  type: z.literal('videoStream'),
  data: z.string().optional(),
  outputIndex: z.number().int().nonnegative().optional(),
  done: z.boolean().optional()
})

const echoPlugin = definePlugin({
  modelType: 'echo',
  displayName: 'Echo Plugin (e2e)',
  addonPackage: 'custom-echo-plugin',
  skipPrimaryModelPathValidation: true,
  loadConfigSchema: z.object({}).passthrough(),

  createModel() {
    return {
      model: {
        async load() {},
        unload() {}
      }
    }
  },

  handlers: {
    echo: defineHandler({
      requestSchema: echoRequestSchema,
      responseSchema: echoResponseSchema,
      streaming: false,
      async handler(request) {
        return { message: request.message }
      }
    }),

    echoStream: defineHandler({
      requestSchema: echoRequestSchema,
      responseSchema: echoStreamChunkSchema,
      streaming: true,
      async *handler(request) {
        const words = request.message.split(' ')
        for (const word of words) {
          yield { chunk: word }
        }
      }
    }),

    videoStream: defineHandler({
      requestSchema: videoStreamRequestSchema,
      responseSchema: videoStreamResponseSchema,
      streaming: true,
      async *handler() {
        yield { type: 'videoStream', data: 'SUNMT1JB', outputIndex: 0 }
        yield { type: 'videoStream', data: 'VklERU8=', outputIndex: 1 }
        yield { type: 'videoStream', done: true }
      }
    })
  }
})

export default echoPlugin
