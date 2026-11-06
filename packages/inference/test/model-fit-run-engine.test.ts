import test from 'brittle'

import { z } from 'zod'

import { callEngineFit } from '@/model-fit/run/engine'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import type { ModelFitModelResult } from '@/schemas/assess-model-fit'
import type { QvacPlugin } from '@/schemas/plugin'

const result: ModelFitModelResult = { status: 'fits', devices: [], stats: {} }

function plugin(overrides: Partial<QvacPlugin>): QvacPlugin {
  return {
    modelType: 'test-fit-engine',
    displayName: 'Test',
    addonPackage: '@qvac/tts-ggml',
    loadConfigSchema: z.looseObject({}),
    createModel: () => ({}) as never,
    handlers: {},
    ...overrides
  } as QvacPlugin
}

test('the fitter is taken from the plugin that owns the addon', async (t) => {
  const registered = plugin({ assessFit: async () => result })
  registerPlugin(registered)
  t.teardown(() => unregisterPlugin(registered.modelType))

  const outcome = await callEngineFit({ addonPackage: '@qvac/tts-ggml', request: undefined })

  t.is(outcome, result)
})

test('a plugin on the same addon with no fitter is passed over', async (t) => {
  const withoutFitter = plugin({ modelType: 'test-fit-engine-plain' })
  const withFitter = plugin({ assessFit: async () => result })
  registerPlugin(withoutFitter)
  registerPlugin(withFitter)
  t.teardown(() => {
    unregisterPlugin(withoutFitter.modelType)
    unregisterPlugin(withFitter.modelType)
  })

  const outcome = await callEngineFit({ addonPackage: '@qvac/tts-ggml', request: undefined })

  t.is(outcome, result, 'the fitter is found whatever the registration order')
})

test('a rejected fit rejects the call', async (t) => {
  const registered = plugin({
    assessFit: async () => {
      throw new TypeError('malformed fit request')
    }
  })
  registerPlugin(registered)
  t.teardown(() => unregisterPlugin(registered.modelType))

  try {
    await callEngineFit({ addonPackage: '@qvac/tts-ggml', request: undefined })
    t.fail('expected the rejected fit to reject the call')
  } catch (error) {
    t.ok(/malformed fit request/.test(String(error)))
  }
})

test('an engine no registered plugin owns is named rather than called', async (t) => {
  try {
    await callEngineFit({ addonPackage: '@qvac/diffusion-cpp', request: undefined })
    t.fail('expected an unowned engine to be rejected')
  } catch (error) {
    t.ok(/no registered plugin exposes assessFit/.test(String(error)))
  }
})
