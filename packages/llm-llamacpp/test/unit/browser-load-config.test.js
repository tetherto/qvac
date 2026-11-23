const test = require('brittle')
const { browserLoadConfig, mountLoadFiles } = require('../../browser/load-config.js')

test('browser load config preserves file-backed model options', (t) => {
  t.alike(browserLoadConfig({ lora: '/models/adapter.gguf' }), {
    lora: '/models/adapter.gguf',
    load_mode: 'none'
  })
  t.alike(browserLoadConfig({ 'spec-draft-model': '/models/draft.gguf' }), {
    'spec-draft-model': '/models/draft.gguf',
    load_mode: 'none'
  })
  t.alike(browserLoadConfig({ spec_draft_model: '/models/draft.gguf' }), {
    spec_draft_model: '/models/draft.gguf',
    load_mode: 'none'
  })
  t.alike(browserLoadConfig({ 'spec-draft-model': '', 'spec-type': 'draft-mtp' }), {
    'spec-draft-model': '',
    'spec-type': 'draft-mtp',
    load_mode: 'none'
  })
})

test('browser load config preserves speculative alias exclusivity', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    for (const config of [
      {
        'spec-draft-model': '/models/draft.gguf',
        spec_draft_model: '/models/draft.gguf'
      },
      {
        'spec-draft-model': '/models/draft-a.gguf',
        spec_draft_model: '/models/draft-b.gguf'
      },
      { 'spec-draft-model': '/models/draft.gguf', spec_draft_model: undefined },
      { 'spec-draft-model': undefined, spec_draft_model: undefined }
    ]) {
      let mountCalls = 0
      await t.exception.all(
        () =>
          mountLoadFiles({ path: '/models/main.gguf', projectionPath: '', config }, () => {
            mountCalls++
            return '/engine/unexpected.gguf'
          }),
        /must not both be set/
      )
      t.is(mountCalls, 0, `iteration ${iteration + 1}`)
    }
  }
})

test('browser load files reject invalid config before mounting', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    let mountCalls = 0
    await t.exception.all(
      () =>
        mountLoadFiles(
          { path: '/models/main.gguf', projectionPath: '', config: { rpc: 'host:50052' } },
          () => {
            mountCalls++
            return '/engine/unexpected.gguf'
          }
        ),
      /rpc is not supported/
    )
    t.is(mountCalls, 0, `iteration ${iteration + 1}`)
  }
})

test('browser load config rejects unavailable native services', (t) => {
  for (const [key, value] of [
    ['rpc-servers', '127.0.0.1:50052'],
    ['rpc_servers', '127.0.0.1:50052'],
    ['rpc', '127.0.0.1:50052'],
    ['backendsDir', '/backends'],
    ['openclCacheDir', '/cache/opencl']
  ]) {
    t.exception(() => browserLoadConfig({ [key]: value }), /not supported/)
  }
})

test('browser load files mounts every model asset once', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const mounted = []
    const files = await mountLoadFiles(
      {
        path: '/models/main.gguf',
        projectionPath: '/models/mmproj.gguf',
        config: {
          lora: '/models/adapter.gguf',
          'spec-draft-model': '/models/draft.gguf'
        }
      },
      (path) => {
        mounted.push(path)
        return `/engine/${mounted.length}/${path.slice(path.lastIndexOf('/') + 1)}`
      }
    )

    t.alike(mounted, [
      '/models/main.gguf',
      '/models/mmproj.gguf',
      '/models/adapter.gguf',
      '/models/draft.gguf'
    ])
    t.alike(files, {
      modelPath: '/engine/1/main.gguf',
      projectionPath: '/engine/2/mmproj.gguf',
      config: {
        lora: '/engine/3/adapter.gguf',
        'spec-draft-model': '/engine/4/draft.gguf',
        load_mode: 'none'
      }
    })
  }
})

test('browser load files reuse one mount for the same source path', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const mounted = []
    const files = await mountLoadFiles(
      {
        path: '/models/main.gguf',
        projectionPath: '/models/shared.gguf',
        config: { lora: '/models/shared.gguf', 'spec-draft-model': '/models/shared.gguf' }
      },
      (path) => {
        mounted.push(path)
        return `/engine/${mounted.length}/${path.slice(path.lastIndexOf('/') + 1)}`
      }
    )

    t.alike(mounted, ['/models/main.gguf', '/models/shared.gguf'])
    t.is(files.projectionPath, '/engine/2/shared.gguf')
    t.is(files.config.lora, '/engine/2/shared.gguf')
    t.is(files.config['spec-draft-model'], '/engine/2/shared.gguf')
  }
})

test('browser load files skip empty optional model assets', async (t) => {
  const mounted = []
  const files = await mountLoadFiles(
    {
      path: '/models/main.gguf',
      projectionPath: '',
      config: { lora: '', 'spec-draft-model': '' }
    },
    (path) => {
      mounted.push(path)
      return `/engine/${path.slice(path.lastIndexOf('/') + 1)}`
    }
  )

  t.alike(mounted, ['/models/main.gguf'])
  t.alike(files, {
    modelPath: '/engine/main.gguf',
    projectionPath: '',
    config: { lora: '', 'spec-draft-model': '', load_mode: 'none' }
  })
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
