'use strict'

// Pure, offline checks for the model manifest (models.js): the three fixed
// stages, the DiT-variant enum, and the registry-path/src resolvers. No native
// addon, no network.

const test = require('brittle')
const m = require('../../models.js')

test('manifest: source, prefix and the DiT-variant enum', (t) => {
  t.is(m.REGISTRY_SOURCE, 's3')
  t.ok(
    m.REGISTRY_PREFIX.startsWith('qvac_models_compiled/ggml/acestep/'),
    'prefix points at the acestep build folder'
  )
  t.alike(m.ditVariants().sort(), ['sft', 'turbo-q4', 'turbo-q8'], 'three DiT variants')
  t.is(m.DEFAULT_DIT_VARIANT, 'turbo-q4')
})

test('ditFilename: known variants resolve, unknown throws', (t) => {
  t.is(m.ditFilename('turbo-q4'), 'acestep-v15-turbo-Q4_K_M.gguf')
  t.is(m.ditFilename('turbo-q8'), 'acestep-v15-turbo-Q8_0.gguf')
  t.is(m.ditFilename('sft'), 'acestep-v15-sft-Q8_0.gguf')
  t.is(m.ditFilename(), m.ditFilename(m.DEFAULT_DIT_VARIANT), 'no arg => default variant')
  t.exception(() => m.ditFilename('nope'), /unknown ditVariant/)
})

test('manifest: 3 fixed stages are constant, only the DiT changes', (t) => {
  const a = m.modelManifest('turbo-q4')
  const b = m.modelManifest('sft')

  t.is(a.textEnc, b.textEnc, 'text-enc fixed across variants')
  t.is(a.lm, b.lm, 'LM fixed across variants')
  t.is(a.vae, b.vae, 'VAE fixed across variants')
  t.not(a.dit, b.dit, 'DiT path changes with the variant')

  t.ok(a.textEnc.endsWith('Qwen3-Embedding-0.6B-Q8_0.gguf'))
  t.ok(a.lm.endsWith('acestep-5Hz-lm-0.6B-Q8_0.gguf'))
  t.ok(a.vae.endsWith('vae-BF16.gguf'))
  t.ok(a.dit.endsWith('acestep-v15-turbo-Q4_K_M.gguf'))
})

test('modelSources: shape consumed by the SDK plugin', (t) => {
  const src = m.modelSources('turbo-q8')
  t.alike(Object.keys(src).sort(), ['ditModelSrc', 'lmModelSrc', 'textEncModelSrc', 'vaeModelSrc'])
  t.ok(src.ditModelSrc.endsWith('acestep-v15-turbo-Q8_0.gguf'))
  t.ok(src.textEncModelSrc.startsWith(m.REGISTRY_PREFIX + '/'))
})

test('allRegistryPaths: 6 distinct paths (3 fixed + 3 DiT), all under prefix', (t) => {
  const all = m.allRegistryPaths()
  t.is(all.length, 6, '3 fixed + 3 DiT variants')
  t.is(new Set(all).size, 6, 'all distinct')
  for (const p of all) t.ok(p.startsWith(m.REGISTRY_PREFIX + '/'), `under prefix: ${p}`)
})

test('resolveDitModelPath: explicit ditModel always wins', (t) => {
  t.is(
    m.resolveDitModelPath({ ditModel: '/abs/custom-dit.gguf', modelDir: '/m', ditVariant: 'sft' }),
    '/abs/custom-dit.gguf',
    'explicit path takes precedence over variant/modelDir'
  )
})

test('resolveDitModelPath: variant + modelDir composes the DiT path', (t) => {
  t.is(
    m.resolveDitModelPath({ modelDir: '/models/acestep', ditVariant: 'turbo-q4' }),
    '/models/acestep/acestep-v15-turbo-Q4_K_M.gguf'
  )
  t.is(
    m.resolveDitModelPath({ modelDir: '/models/acestep///', ditVariant: 'sft' }),
    '/models/acestep/acestep-v15-sft-Q8_0.gguf',
    'trailing separators are stripped'
  )
})

test('resolveDitModelPath: undefined when neither ditModel nor ditVariant given', (t) => {
  t.is(m.resolveDitModelPath({ modelDir: '/models/acestep' }), undefined)
  t.is(m.resolveDitModelPath({}), undefined)
})

test('resolveDitModelPath: ditVariant without modelDir throws', (t) => {
  t.exception(
    () => m.resolveDitModelPath({ ditVariant: 'turbo-q4' }),
    /`ditVariant` needs `modelDir`/
  )
})

test('resolveDitModelPath: unknown variant throws', (t) => {
  t.exception(
    () => m.resolveDitModelPath({ modelDir: '/m', ditVariant: 'nope' }),
    /unknown ditVariant/
  )
})
