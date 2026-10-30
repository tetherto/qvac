'use strict'

const test = require('brittle')
const binding = require('../../binding')
const TTSGgml = require('../../index')

const POCKET_FIT = {
  engineType: 'pocket',
  pocketFlowModelPath: '/missing/flow-lm.gguf',
  pocketMimiModelPath: '/missing/mimi.gguf',
  pocketFrontendPath: '/missing/frontend.json',
  pocketVoicePath: '/missing/voice.gguf',
  text: 'Project this sentence.'
}

test('Pocket preflight reaches its native fitter and validates explicit byte budgets', async (t) => {
  const result = await TTSGgml.assessFit(POCKET_FIT)
  t.is(result.status, 'unknown', 'an unmeasurable native projection stays unknown')
  t.alike(result.devices, [])
  t.alike(result.stats, {})
  for (const memoryBudgetBytes of [-1, 1.5, Infinity]) {
    await t.exception(
      TTSGgml.assessFit({ ...POCKET_FIT, memoryBudgetBytes }),
      /count|integer|finite/
    )
  }
})

test('native option parsing rejects malformed vectors and environment maps before loading weights', (t) => {
  const cases = [
    ['cosyvoice3', { forceSpeechTokens: [1.5] }, /integer/],
    ['cosyvoice3', { forceSpeechTokens: [NaN] }, /integer/],
    ['supertonic', { voiceStyleTtl: new Float32Array([Infinity]) }, /finite/],
    ['supertonic', { voiceStyleDp: ['invalid'] }, /numbers/],
    ['supertonic', { vulkanEnvOverrides: { GGML_VK_TEST: false } }, /string/],
    ['moss', { textTemperature: Infinity }, /finite/]
  ]
  for (const [engineType, fields, error] of cases) {
    t.exception(() => binding.createInstance({}, { engineType, ...fields }, () => {}), error)
  }
})
