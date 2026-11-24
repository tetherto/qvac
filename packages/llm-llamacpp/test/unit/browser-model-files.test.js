'use strict'

const test = require('brittle')
const {
  MOUNTED_FILES_KEY,
  modelFiles,
  orderedShards,
  shardInfo
} = require('../../browser/model-files.js')

function file(name) {
  return { name }
}

function mount(files) {
  globalThis[MOUNTED_FILES_KEY] = new Map(files)
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
