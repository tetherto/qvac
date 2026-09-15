import { z } from 'zod'
import { definePlugin, defineHandler } from '@qvac/sdk'
import { runFitStubCheck } from './check.mjs'

// The SDK resolves (and downloads) the catalogue GGUF and hands its cache path
// to createModel. Nothing is loaded into an engine: createModel only records
// the path so the `check` handler can build a header-only stub next to it.
// Handlers receive the caller's params verbatim, so the client wrapper passes
// the modelId along and the handler looks the path up here.
const modelPaths = new Map()

const checkRequestSchema = z.object({
  modelId: z.string(),
  nCtx: z.number().int().positive().default(4096),
  marginMiB: z.number().int().nonnegative().default(1024),
  backendsDir: z.string().optional()
})

const checkResponseSchema = z.object({}).passthrough()

const fitStubPlugin = definePlugin({
  modelType: 'fit-stub-check',
  displayName: 'Fit stub check (e2e)',
  addonPackage: 'custom-fit-stub-plugin',
  loadConfigSchema: z.object({}).passthrough(),

  createModel({ modelId, modelPath }) {
    modelPaths.set(modelId, modelPath)
    return {
      model: {
        async load() {},
        unload() {
          modelPaths.delete(modelId)
        }
      }
    }
  },

  handlers: {
    check: defineHandler({
      requestSchema: checkRequestSchema,
      responseSchema: checkResponseSchema,
      streaming: false,
      async handler(request) {
        const { modelId, ...options } = request
        const modelPath = modelPaths.get(modelId)
        if (typeof modelPath !== 'string') {
          return {
            errors: { fatal: `no model path recorded for ${modelId}` },
            verdict: { sparseOk: false, stubLoads: false, planIdentical: false, pass: false }
          }
        }
        return runFitStubCheck({ modelPath, ...options })
      }
    })
  }
})

export default fitStubPlugin
