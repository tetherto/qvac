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
    })
  }
})

export default echoPlugin
