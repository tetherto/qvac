const test = require('brittle')
const { browserLoadConfig } = require('../../browser/load-config.js')

test('browser load config rejects external speculative draft models', (t) => {
  for (const key of ['spec-draft-model', 'spec_draft_model']) {
    t.exception(() => browserLoadConfig({ [key]: '/models/draft.gguf' }), /not supported/)
  }
  t.alike(browserLoadConfig({ 'spec-draft-model': '', 'spec-type': 'draft-mtp' }), {
    'spec-draft-model': '',
    'spec-type': 'draft-mtp',
    load_mode: 'none'
  })
})

test('browser load config rejects unmounted files and unavailable native services', (t) => {
  for (const [key, value] of [
    ['lora', '/models/adapter.gguf'],
    ['rpc-servers', '127.0.0.1:50052'],
    ['rpc_servers', '127.0.0.1:50052'],
    ['rpc', '127.0.0.1:50052'],
    ['backendsDir', '/backends'],
    ['openclCacheDir', '/cache/opencl']
  ]) {
    t.exception(() => browserLoadConfig({ [key]: value }), /not supported/)
  }
})

test('browser load config selects plain reads', (t) => {
  t.alike(browserLoadConfig({ device: 'gpu' }), { device: 'gpu', load_mode: 'none' })
  t.alike(browserLoadConfig({ load_mode: 'AUTO' }), { load_mode: 'none' })
  t.alike(browserLoadConfig({ 'load-mode': 'none' }), { load_mode: 'none' })
  t.alike(browserLoadConfig({ load_mode: 'AUTO', 'load-mode': 'auto' }), {
    load_mode: 'none'
  })
})

test('browser load config matches native string coercion', (t) => {
  t.alike(browserLoadConfig({ ctx_size: 4096, flash_attn: true }), {
    ctx_size: '4096',
    flash_attn: 'true',
    load_mode: 'none'
  })
})

test('browser load config rejects incompatible load controls', async (t) => {
  for (const key of [
    'mmap',
    'no-mmap',
    'no_mmap',
    'direct-io',
    'direct_io',
    'no-direct-io',
    'no_direct_io',
    'mlock'
  ]) {
    await t.exception(
      Promise.resolve().then(() => browserLoadConfig({ [key]: 'true' })),
      /is not supported/
    )
  }
  await t.exception(
    Promise.resolve().then(() => browserLoadConfig({ load_mode: 'mmap' })),
    /is not supported/
  )
  await t.exception(
    Promise.resolve().then(() => browserLoadConfig({ load_mode: 'auto', 'load-mode': 'none' })),
    /must have the same value/
  )
  await t.exception(
    Promise.resolve().then(() => browserLoadConfig({ load_mode: 1 })),
    /must be a string/
  )
})
