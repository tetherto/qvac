'use strict'

const test = require('brittle')
const {
  MOUNTED_FILES_KEY,
  modelFiles,
  mountModelFiles,
  orderedShards,
  shardInfo,
  unmountModelFiles
} = require('../../browser/model-files.js')
const { mountLoadFiles } = require('../../browser/load-config.js')

function file(name) {
  return { name }
}

function mount(files) {
  globalThis[MOUNTED_FILES_KEY] = new Map(files)
}

function mockModule({ failMountAt = 0, failUnmountAt = 0, failRmdirAt = 0 } = {}) {
  const active = new Set()
  const mounted = []
  const unmounted = []
  const removed = []
  let mountCalls = 0
  let unmountCalls = 0
  let rmdirCalls = 0
  return {
    active,
    mounted,
    unmounted,
    removed,
    allowMounts() {
      failMountAt = 0
    },
    allowCleanup() {
      failUnmountAt = 0
      failRmdirAt = 0
    },
    FS: {
      filesystems: { WORKERFS: {} },
      mkdirTree() {},
      mount(_filesystem, _options, mountpoint) {
        mountCalls++
        if (mountCalls === failMountAt) throw new Error('mount failed')
        if (active.has(mountpoint)) throw new Error(`duplicate mount: ${mountpoint}`)
        active.add(mountpoint)
        mounted.push(mountpoint)
      },
      unmount(mountpoint) {
        unmountCalls++
        if (unmountCalls === failUnmountAt) throw new Error('unmount failed')
        if (!active.delete(mountpoint)) throw new Error(`unknown mount: ${mountpoint}`)
        unmounted.push(mountpoint)
      },
      rmdir(mountpoint) {
        rmdirCalls++
        if (rmdirCalls === failRmdirAt) throw new Error('rmdir failed')
        removed.push(mountpoint)
      }
    }
  }
}

function loadParams() {
  return {
    path: '/models/main.gguf',
    projectionPath: '/models/mmproj.gguf',
    config: {
      lora: '/models/adapter.gguf',
      'spec-draft-model': '/models/draft.gguf'
    }
  }
}

function installLoadFiles() {
  mount([
    ['/models/main.gguf', file('main.gguf')],
    ['/models/mmproj.gguf', file('mmproj.gguf')],
    ['/models/adapter.gguf', file('adapter.gguf')],
    ['/models/draft.gguf', file('draft.gguf')]
  ])
}

function installOpfs(files, otherEntries = []) {
  const directory = {
    getFileHandle(name) {
      if (!files.has(name)) throw new Error(`missing ${name}`)
      return Promise.resolve({ getFile: () => Promise.resolve(files.get(name)) })
    },
    async *entries() {
      for (const [name, value] of files) {
        yield [name, { kind: 'file', getFile: () => Promise.resolve(value) }]
      }
      for (const entry of otherEntries) yield entry
    }
  }
  const root = {
    getDirectoryHandle(name) {
      if (name !== 'models') throw new Error(`missing directory ${name}`)
      return Promise.resolve(directory)
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
}

test('browser model file resolver returns a mounted single-file model', async (t) => {
  t.teardown(() => delete globalThis[MOUNTED_FILES_KEY])
  const model = file('model.gguf')
  mount([['/models/model.gguf', model]])

  t.alike(await modelFiles('/models/model.gguf'), { primary: model, files: [model] })
})

test('browser model file resolver mounts one complete shard set in order', async (t) => {
  t.teardown(() => delete globalThis[MOUNTED_FILES_KEY])
  const first = file('model-00001-of-00003.gguf')
  const second = file('model-00002-of-00003.gguf')
  const third = file('model-00003-of-00003.gguf')
  mount([
    ['/models/model-00003-of-00003.gguf', third],
    ['/models/other-00001-of-00003.gguf', file('other-00001-of-00003.gguf')],
    ['/models/nested/model-00002-of-00003.gguf', second],
    ['/models/model.tensors.txt', file('model.tensors.txt')],
    [
      '/models/unrelated-9007199254740992-of-9007199254740992.gguf',
      file('unrelated-9007199254740992-of-9007199254740992.gguf')
    ],
    ['/models/model-00001-of-00003.gguf', first],
    ['/models/model-00002-of-00003.gguf', second]
  ])

  for (let iteration = 0; iteration < 20; iteration++) {
    t.alike(await modelFiles('/models/model-00001-of-00003.gguf'), {
      primary: first,
      files: [first, second, third]
    })
  }
})

test('browser model file resolver discovers shards in OPFS', async (t) => {
  t.teardown(() => delete globalThis.navigator)
  const first = file('model-00001-of-00002.gguf')
  const second = file('model-00002-of-00002.gguf')
  installOpfs(
    new Map([
      [second.name, second],
      ['other.gguf', file('other.gguf')],
      [
        'unrelated-9007199254740992-of-9007199254740992.gguf',
        file('unrelated-9007199254740992-of-9007199254740992.gguf')
      ],
      [first.name, first]
    ])
  )

  for (let iteration = 0; iteration < 20; iteration++) {
    t.alike(await modelFiles(`/models/${first.name}`), {
      primary: first,
      files: [first, second]
    })
  }
})

test('browser model file resolver ignores matching OPFS directories before parsing shards', async (t) => {
  t.teardown(() => delete globalThis.navigator)
  const first = file('model-00001-of-00002.gguf')
  const second = file('model-00002-of-00002.gguf')
  installOpfs(
    new Map([
      [first.name, first],
      [second.name, second]
    ]),
    [['model-9007199254740992-of-00002.gguf', { kind: 'directory' }]]
  )

  t.alike(await modelFiles(`/models/${first.name}`), {
    primary: first,
    files: [first, second]
  })
})

test('browser model file resolver requires the first shard', async (t) => {
  await t.exception.all(
    () => modelFiles('/models/model-00002-of-00003.gguf'),
    /must be loaded from its first shard/
  )
})

test('browser model file resolver rejects incomplete and inconsistently padded shard sets', async (t) => {
  t.teardown(() => delete globalThis[MOUNTED_FILES_KEY])
  const first = file('model-00001-of-00003.gguf')
  mount([
    ['/models/model-00001-of-00003.gguf', first],
    ['/models/model-2-of-00003.gguf', file('model-2-of-00003.gguf')],
    ['/models/model-00003-of-00003.gguf', file('model-00003-of-00003.gguf')]
  ])

  await t.exception.all(
    () => modelFiles('/models/model-00001-of-00003.gguf'),
    /Expected 3 model shards beside .* found 2/
  )
})

test('browser shard validation does not allocate from an untrusted declared count', async (t) => {
  const expected = shardInfo('model-0000000000000001-of-9007199254740991.gguf')
  await t.exception.all(
    () =>
      orderedShards([file('model-0000000000000001-of-9007199254740991.gguf')], expected, '/model'),
    /Expected 9007199254740991 model shards/
  )
})

test('browser shard validation rejects unsafe numeric fields', async (t) => {
  await t.exception.all(
    () => shardInfo('model-9007199254740992-of-9007199254740992.gguf'),
    /Invalid sharded model filename/
  )
})

test('browser model file resolver requires an absolute file path', async (t) => {
  await t.exception.all(() => modelFiles('models/model.gguf'), /Expected an absolute OPFS path/)
  await t.exception.all(() => modelFiles('/'), /Expected an OPFS file path/)
})

test('browser model mounts release every load asset exactly once', async (t) => {
  t.teardown(() => delete globalThis[MOUNTED_FILES_KEY])
  installLoadFiles()

  for (let iteration = 0; iteration < 20; iteration++) {
    const module = mockModule()
    const mounts = []
    let nextMount = 0
    await mountLoadFiles(loadParams(), (path) =>
      mountModelFiles(module, mounts, `/qvac-files/${++nextMount}`, path)
    )

    t.alike(module.mounted, ['/qvac-files/1', '/qvac-files/2', '/qvac-files/3', '/qvac-files/4'])
    unmountModelFiles(module, mounts)
    t.alike(module.unmounted, module.mounted, `iteration ${iteration + 1}`)
    t.alike(module.removed, module.mounted, `iteration ${iteration + 1}`)
    t.is(module.active.size, 0, `iteration ${iteration + 1}`)
    t.alike(mounts, [], `iteration ${iteration + 1}`)
  }
})

test('browser model mounts clean a partial failure and allow a retry', async (t) => {
  t.teardown(() => delete globalThis[MOUNTED_FILES_KEY])
  installLoadFiles()

  for (let iteration = 0; iteration < 20; iteration++) {
    const module = mockModule({ failMountAt: 2 })
    const mounts = []
    let nextMount = 0
    const mountFile = (path) => mountModelFiles(module, mounts, `/qvac-files/${++nextMount}`, path)

    await t.exception.all(() => mountLoadFiles(loadParams(), mountFile), /mount failed/)
    t.alike(mounts, ['/qvac-files/1'], `partial iteration ${iteration + 1}`)
    unmountModelFiles(module, mounts)
    t.is(module.active.size, 0, `cleaned iteration ${iteration + 1}`)
    t.alike(module.unmounted, ['/qvac-files/1'], `cleaned iteration ${iteration + 1}`)
    t.alike(
      module.removed,
      ['/qvac-files/2', '/qvac-files/1'],
      `cleaned iteration ${iteration + 1}`
    )

    module.allowMounts()
    await mountLoadFiles(loadParams(), mountFile)
    t.alike(mounts, ['/qvac-files/3', '/qvac-files/4', '/qvac-files/5', '/qvac-files/6'])
    unmountModelFiles(module, mounts)
    t.is(module.active.size, 0, `retried iteration ${iteration + 1}`)
    t.alike(mounts, [], `retried iteration ${iteration + 1}`)
    t.alike(
      module.unmounted,
      ['/qvac-files/1', '/qvac-files/3', '/qvac-files/4', '/qvac-files/5', '/qvac-files/6'],
      `retried iteration ${iteration + 1}`
    )
  }
})

test('browser model unmount continues after an unmount failure and retains it for retry', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const module = mockModule({ failUnmountAt: 1 })
    const mounts = ['/qvac-files/1', '/qvac-files/2', '/qvac-files/3', '/qvac-files/4']
    for (const mountpoint of mounts) module.active.add(mountpoint)

    t.exception(() => unmountModelFiles(module, mounts), /unmount failed/)
    t.alike(module.unmounted, ['/qvac-files/2', '/qvac-files/3', '/qvac-files/4'])
    t.alike(module.removed, ['/qvac-files/2', '/qvac-files/3', '/qvac-files/4'])
    t.alike([...module.active], ['/qvac-files/1'])
    t.alike(mounts, [{ mountpoint: '/qvac-files/1', mounted: true }])

    module.allowCleanup()
    unmountModelFiles(module, mounts)
    t.is(module.active.size, 0, `iteration ${iteration + 1}`)
    t.alike(mounts, [], `iteration ${iteration + 1}`)
  }
})

test('browser model unmount retains a failed directory removal for retry', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const module = mockModule({ failRmdirAt: 1 })
    const mounts = ['/qvac-files/1', '/qvac-files/2', '/qvac-files/3', '/qvac-files/4']
    for (const mountpoint of mounts) module.active.add(mountpoint)

    t.exception(() => unmountModelFiles(module, mounts), /rmdir failed/)
    t.alike(module.unmounted, ['/qvac-files/1', '/qvac-files/2', '/qvac-files/3', '/qvac-files/4'])
    t.alike(module.removed, ['/qvac-files/2', '/qvac-files/3', '/qvac-files/4'])
    t.is(module.active.size, 0, `iteration ${iteration + 1}`)
    t.alike(mounts, [{ mountpoint: '/qvac-files/1', mounted: false }])

    module.allowCleanup()
    unmountModelFiles(module, mounts)
    t.alike(module.unmounted, ['/qvac-files/1', '/qvac-files/2', '/qvac-files/3', '/qvac-files/4'])
    t.alike(mounts, [], `iteration ${iteration + 1}`)
  }
})

test('browser model mount failure retains failed directory cleanup for retry', async (t) => {
  t.teardown(() => delete globalThis[MOUNTED_FILES_KEY])
  mount([['/models/main.gguf', file('main.gguf')]])

  for (let iteration = 0; iteration < 20; iteration++) {
    const module = mockModule({ failMountAt: 1, failRmdirAt: 1 })
    const mounts = []

    await t.exception.all(
      () => mountModelFiles(module, mounts, '/qvac-files/1', '/models/main.gguf'),
      /mount failed/
    )
    t.alike(mounts, [{ mountpoint: '/qvac-files/1', mounted: false }])

    module.allowCleanup()
    unmountModelFiles(module, mounts)
    t.alike(module.unmounted, [], `never-mounted path is not unmounted, iteration ${iteration + 1}`)
    t.alike(module.removed, ['/qvac-files/1'], `directory retried, iteration ${iteration + 1}`)
    t.alike(mounts, [], `iteration ${iteration + 1}`)
  }
})
