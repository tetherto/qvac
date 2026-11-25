const test = require('brittle')
const {
  browserLoadConfig,
  checkLoadFiles,
  mountLoadFiles
} = require('../../browser/load-config.js')

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
    ['openclCacheDir', '/cache/opencl'],
    ['lora-scaled', '/m/lora.gguf:0.5'],
    ['lora_scaled', '/m/lora.gguf:0.5'],
    ['control-vector', '/m/vector.gguf'],
    ['control_vector', '/m/vector.gguf'],
    ['control-vector-scaled', '/m/vector.gguf:0.5'],
    ['control_vector_scaled', '/m/vector.gguf:0.5']
  ]) {
    t.exception(() => browserLoadConfig({ [key]: value }), /not supported/)
  }
  t.is(browserLoadConfig({ lora: '/m/a.gguf' }).lora, '/m/a.gguf')
  t.absent(Object.hasOwn(browserLoadConfig({ lora: '' }), 'lora'), 'empty lora dropped')
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

test('browser load files check every asset path before mounting', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    for (const [params, message] of [
      [{ path: 'main.gguf' }, /absolute OPFS path, got: main\.gguf/],
      [{ projectionPath: 'mmproj.gguf' }, /absolute OPFS path, got: mmproj\.gguf/],
      [{ config: { lora: 'adapter.gguf' } }, /absolute OPFS path, got: adapter\.gguf/],
      [{ config: { 'spec-draft-model': 'draft.gguf' } }, /absolute OPFS path, got: draft\.gguf/],
      [{ config: { spec_draft_model: '/m/d-00002-of-00002.gguf' } }, /first shard/]
    ]) {
      const mounted = []
      const all = { path: '/models/main.gguf', config: {}, ...params }
      t.exception.all(() => checkLoadFiles(all), message)
      await t.exception.all(() => mountLoadFiles(all, (path) => mounted.push(path)), message)
      t.is(mounted.length, 0, `nothing mounted, iteration ${iteration + 1}`)
    }
  }
})

test('browser load files keep a comma in a lora path as one CSV field', async (t) => {
  const mount = (path) => `/engine/1/${path.slice(path.lastIndexOf('/') + 1)}`
  for (let iteration = 0; iteration < 20; iteration++) {
    const directory = await mountLoadFiles(
      { path: '/models/main.gguf', config: { lora: '/models/experiments,2026/adapter.gguf' } },
      mount
    )
    t.is(
      directory.config.lora,
      '/engine/1/adapter.gguf',
      'comma in a directory never reaches the engine'
    )

    const name = await mountLoadFiles(
      { path: '/models/main.gguf', config: { lora: '/models/a,"b".gguf' } },
      mount
    )
    t.is(name.config.lora, '"/engine/1/a,""b"".gguf"', 'quoted for the CSV parser')
  }
})

test('browser load files name the one-adapter rule when a comma path is missing', async (t) => {
  const missing = new Error('A requested file or directory could not be found')
  missing.name = 'NotFoundError'
  for (let iteration = 0; iteration < 20; iteration++) {
    const error = await mountLoadFiles(
      { path: '/models/main.gguf', config: { lora: '/m/a.gguf,/m/b.gguf' } },
      (path) => {
        if (path !== '/models/main.gguf') throw missing
        return '/engine/main.gguf'
      }
    ).catch((caught) => caught)
    t.ok(
      /could not be found \(lora takes one adapter path in the browser build\)$/.test(error.message)
    )
    t.is(error.cause, missing)
    t.is(error.name, 'NotFoundError')

    const shardError = new Error(
      'Expected 2 model shards beside /m,x/a-00001-of-00002.gguf, found 1'
    )
    const unhinted = await mountLoadFiles(
      { path: '/models/main.gguf', config: { lora: '/m,x/a-00001-of-00002.gguf' } },
      (path) => {
        if (path !== '/models/main.gguf') throw shardError
        return '/engine/main.gguf'
      }
    ).catch((caught) => caught)
    t.is(unhinted, shardError, 'only a missing file gets the hint')

    await t.exception.all(
      () =>
        mountLoadFiles(
          { path: '/models/main.gguf', config: { lora: '/models/exp,2026/missing.gguf' } },
          (path) => {
            if (path !== '/models/main.gguf') throw missing
            return '/engine/main.gguf'
          }
        ),
      /could not be found$/
    )

    await t.exception.all(
      () =>
        mountLoadFiles(
          { path: '/models/main.gguf', config: { lora: '/m/missing.gguf' } },
          (path) => {
            if (path !== '/models/main.gguf') throw missing
            return '/engine/main.gguf'
          }
        ),
      /A requested file or directory could not be found$/
    )
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
    config: { 'spec-draft-model': '', load_mode: 'none' }
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
