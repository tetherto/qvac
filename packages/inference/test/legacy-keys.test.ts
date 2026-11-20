import test from 'brittle'
import {
  createLegacyKeyWarner,
  renameLegacyKeys,
  type LegacyKeySpec
} from '@/schemas/legacy-keys'

const spec: LegacyKeySpec = {
  renames: { ctx_size: 'ctxSize', 'batch-size': 'batchSize', vad_params: 'vadParams' },
  nested: {
    vadParams: { renames: { speech_pad_ms: 'speechPadMs' } },
    prompts: { renames: { top_k: 'topK' } }
  }
}

function collectWarnings() {
  const warnings: [string, string][] = []
  return {
    warnings,
    warn: (legacyPath: string, replacementPath: string) => {
      warnings.push([legacyPath, replacementPath])
    }
  }
}

test('renameLegacyKeys moves each legacy key to its replacement', (t) => {
  const { warnings, warn } = collectWarnings()
  const renamed = renameLegacyKeys({ ctx_size: 2048, 'batch-size': 512, seed: 1 }, spec, warn)
  t.alike(renamed, { ctxSize: 2048, batchSize: 512, seed: 1 })
  t.alike(warnings, [
    ['ctx_size', 'ctxSize'],
    ['batch-size', 'batchSize']
  ])
})

test('renameLegacyKeys keeps the camelCase value when both spellings are sent', (t) => {
  const { warnings, warn } = collectWarnings()
  t.alike(renameLegacyKeys({ ctx_size: 1024, ctxSize: 4096 }, spec, warn), { ctxSize: 4096 })
  t.alike(warnings, [['ctx_size', 'ctxSize']])
})

test('renameLegacyKeys renames inside a renamed child object', (t) => {
  const { warnings, warn } = collectWarnings()
  const renamed = renameLegacyKeys({ vad_params: { speech_pad_ms: 30 } }, spec, warn, 'modelConfig')
  t.alike(renamed, { vadParams: { speechPadMs: 30 } })
  t.alike(warnings, [
    ['modelConfig.vad_params', 'modelConfig.vadParams'],
    ['modelConfig.vadParams.speech_pad_ms', 'modelConfig.vadParams.speechPadMs']
  ])
})

test('renameLegacyKeys renames every item of a child array', (t) => {
  const { warnings, warn } = collectWarnings()
  const renamed = renameLegacyKeys({ prompts: [{ top_k: 5 }, { topK: 7 }] }, spec, warn)
  t.alike(renamed, { prompts: [{ topK: 5 }, { topK: 7 }] })
  t.alike(warnings, [['prompts[0].top_k', 'prompts[0].topK']])
})

test('renameLegacyKeys returns the input itself when it holds no legacy key', (t) => {
  const { warnings, warn } = collectWarnings()
  const input = { ctxSize: 2048, prompts: [{ topK: 1 }] }
  t.is(renameLegacyKeys(input, spec, warn), input)
  t.is(warnings.length, 0)
})

test('renameLegacyKeys leaves the input unmodified', (t) => {
  const input = { ctx_size: 2048, vad_params: { speech_pad_ms: 30 } }
  renameLegacyKeys(input, spec, () => {})
  t.alike(input, { ctx_size: 2048, vad_params: { speech_pad_ms: 30 } })
})

test('createLegacyKeyWarner logs each legacy path once, naming the replacement', (t) => {
  const messages: string[] = []
  const warn = createLegacyKeyWarner((message) => messages.push(message))
  warn('prompts[0].top_k', 'prompts[0].topK')
  warn('prompts[1].top_k', 'prompts[1].topK')
  warn('modelConfig.ctx_size', 'modelConfig.ctxSize')
  t.alike(messages, [
    '"prompts[0].top_k" is deprecated and will be removed in the next release. Use "prompts[0].topK" instead.',
    '"modelConfig.ctx_size" is deprecated and will be removed in the next release. Use "modelConfig.ctxSize" instead.'
  ])
})
