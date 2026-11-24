const test = require('brittle')
const {
  INDICTRANS_MODELS,
  getIndicTransFileName,
  ensureIndicTransModelFile
} = require('../../lib/indictrans-model-fetcher')

const REGISTRY_PATHS = {
  'en-indic-200M-q4_0':
    'qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-en-indic-dist-200M/2026-01-01/ggml-indictrans2-en-indic-dist-200M-q4_0.bin',
  'en-indic-200M-f16':
    'qvac_models_compiled/ggml/indictrans2/f16/ggml-indictrans2-en-indic-dist-200M/2026-01-01/ggml-indictrans2-en-indic-dist-200M-f16.bin',
  'en-indic-1B-q4_0':
    'qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-en-indic-1B/2026-01-01/ggml-indictrans2-en-indic-1B-q4_0.bin',
  'en-indic-1B-f16':
    'qvac_models_compiled/ggml/indictrans2/f16/ggml-indictrans2-en-indic-1B/2026-01-01/ggml-indictrans2-en-indic-1B-f16.bin',
  'indic-en-200M-q4_0':
    'qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-indic-en-dist-200M/2026-01-01/ggml-indictrans2-indic-en-dist-200M-q4_0.bin',
  'indic-en-200M-f16':
    'qvac_models_compiled/ggml/indictrans2/f16/ggml-indictrans2-indic-en-dist-200M/2026-01-01/ggml-indictrans2-indic-en-dist-200M-f16.bin',
  'indic-en-1B-q4_0':
    'qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-indic-en-1B/2026-01-01/ggml-indictrans2-indic-en-1B-q4_0.bin',
  'indic-en-1B-f16':
    'qvac_models_compiled/ggml/indictrans2/f16/ggml-indictrans2-indic-en-1B/2026-01-01/ggml-indictrans2-indic-en-1B-f16.bin',
  'indic-indic-320M-q4_0':
    'qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-indic-indic-dist-320M/2026-01-01/ggml-indictrans2-indic-indic-dist-320M-q4_0.bin',
  'indic-indic-320M-f16':
    'qvac_models_compiled/ggml/indictrans2/f16/ggml-indictrans2-indic-indic-dist-320M/2026-01-01/ggml-indictrans2-indic-indic-dist-320M-f16.bin',
  'indic-indic-1B-q4_0':
    'qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-indic-indic-1B/2026-01-01/ggml-indictrans2-indic-indic-1B-q4_0.bin',
  'indic-indic-1B-f16':
    'qvac_models_compiled/ggml/indictrans2/f16/ggml-indictrans2-indic-indic-1B/2026-01-01/ggml-indictrans2-indic-indic-1B-f16.bin'
}

test('INDICTRANS_MODELS covers every registry IndicTrans2 model', (t) => {
  t.alike(Object.keys(INDICTRANS_MODELS).sort(), Object.keys(REGISTRY_PATHS).sort())
})

test('each IndicTrans2 key resolves to its registry path and filename', (t) => {
  for (const [key, registryPath] of Object.entries(REGISTRY_PATHS)) {
    const model = INDICTRANS_MODELS[key]
    t.is(model.registryPath, registryPath, key)
    t.is(model.registrySource, 's3', key)
    t.is(getIndicTransFileName(key), registryPath.split('/').pop(), key)
  }
})

test('getIndicTransFileName defaults to the 200M English to Indic model', (t) => {
  t.is(getIndicTransFileName(), 'ggml-indictrans2-en-indic-dist-200M-q4_0.bin')
})

test('unknown IndicTrans2 keys are rejected', async (t) => {
  t.exception(() => getIndicTransFileName('en-indic-2B-q4_0'), /Unknown IndicTrans model key/)
  await t.exception(
    ensureIndicTransModelFile('unused.bin', 'en-indic-2B-q4_0'),
    /Unknown IndicTrans model key/
  )
})
