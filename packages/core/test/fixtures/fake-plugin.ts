// Addon-free plugin fixture. Core's tests assemble engines without pulling in
// native addon packages: this fake satisfies the QvacPlugin contract with a
// stub model and a trivial `ping` handler, so registration, dispatch, and
// lifecycle can be exercised in-process on Bare with no compiled dependency.
import { z } from 'zod'
import { definePlugin, defineHandler } from '../../src/schemas/plugin'
import type { QvacPlugin } from '../../src/schemas/plugin'

export function makeFakePlugin(modelType: string): QvacPlugin {
  return definePlugin({
    modelType,
    displayName: `Fake ${modelType}`,
    addonPackage: `@qvac/fake-${modelType}`,
    loadConfigSchema: z.object({}),
    createModel() {
      return {
        model: {
          load: async function () {},
          unload: async function () {}
        }
      }
    },
    handlers: {
      ping: defineHandler({
        requestSchema: z.object({}),
        responseSchema: z.object({ ok: z.boolean() }),
        streaming: false,
        handler: async function () {
          return { ok: true }
        }
      })
    }
  })
}
