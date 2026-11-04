import test from 'brittle'

import { z } from 'zod'

import { callEngineFit } from '@/model-fit/run/engine'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import type { QvacPlugin } from '@/schemas/plugin'

const result = { status: 'fits', reason: 'fits' }

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
  const registered = plugin({ assessFit: async () => result as never })
  registerPlugin(registered)
  t.teardown(() => unregisterPlugin(registered.modelType))

  const outcome = await callEngineFit({ engine: 'tts-ggml', request: undefined as never })

  t.is(outcome.engine, 'tts-ggml')
  t.is(outcome.result as unknown, result)
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
    await callEngineFit({ engine: 'tts-ggml', request: undefined as never })
    t.fail('expected the rejected fit to reject the call')
  } catch (error) {
    t.ok(/malformed fit request/.test(String(error)))
  }
})

test('an engine no registered plugin owns is named rather than called', async (t) => {
  try {
    await callEngineFit({ engine: 'diffusion-cpp', request: undefined as never })
    t.fail('expected an unowned engine to be rejected')
  } catch (error) {
    t.ok(/no registered plugin exposes assessFit/.test(String(error)))
  }
})
