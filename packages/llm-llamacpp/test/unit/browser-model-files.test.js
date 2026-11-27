'use strict'

const test = require('brittle')
const {
  MOUNTED_FILES_KEY,
  modelFiles,
  installReadAhead,
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
      filesystems: { WORKERFS: { stream_ops: { read() {} } } },
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

function readAheadFixture(sizes) {
  const calls = []
  const files = sizes.map((size, index) => {
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + index * 7) & 0xff
    return {
      bytes,
      slice: (start, end) => ({
        size: Math.max(0, Math.min(end, size) - start),
        source: bytes,
        start,
        end: Math.min(end, size)
      })
    }
  })
  const direct = (stream, buffer, offset, length, position) => {
    if (position >= stream.node.size) return 0
    const chunk = stream.node.contents.slice(position, position + length)
    calls.push({ direct: true, bytes: chunk.size })
    buffer.set(chunk.source.subarray(chunk.start, chunk.end), offset)
    return chunk.size
  }
  const module = {
    FS: {
      filesystems: { WORKERFS: { stream_ops: { read: direct } } },
      unmount() {},
      rmdir() {}
    }
  }
  globalThis.FileReaderSync = class {
    readAsArrayBuffer(blob) {
      calls.push({ direct: false, bytes: blob.size })
      return blob.source.slice(blob.start, blob.end).buffer
    }
  }
  installReadAhead(module)
  const streams = files.map((file, index) => ({ node: { contents: file, size: sizes[index] } }))
  function read(index, position, length) {
    const buffer = new Int8Array(length + 8)
    const count = module.FS.filesystems.WORKERFS.stream_ops.read(
      streams[index],
      buffer,
      8,
      length,
      position
    )
    return { count, bytes: new Uint8Array(buffer.buffer, 8, count) }
  }
  return { module, files, calls, read }
}

function readAll(fixture, index, size, chunk) {
  const out = new Uint8Array(size)
  let position = 0
  while (position < size) {
    const { count, bytes } = fixture.read(index, position, chunk)
    if (count < 1) break
    out.set(bytes, position)
    position += count
  }
  return { out, position }
}

test('browser read-ahead returns exactly the bytes of a direct read 20x', (t) => {
  t.teardown(() => delete globalThis.FileReaderSync)
  const MiB = 1024 * 1024
  for (let iteration = 0; iteration < 20; iteration++) {
    const sizes = [9 * MiB + 123, 5 * MiB + 7]
    const { files, read } = readAheadFixture(sizes)
    let seed = iteration + 1
    const random = (limit) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % limit
    }
    let mismatches = 0
    const position = [0, 0]
    for (let step = 0; step < 400; step++) {
      const index = random(2)
      // Mix sequential runs, jumps, reads past the end and large reads.
      if (step % 7 === 0) position[index] = random(sizes[index] + 16)
      const length = step % 50 === 0 ? 5 * MiB : 1 + random(64 * 1024)
      const at = position[index]
      const { count, bytes } = read(index, at, length)
      const expected = files[index].bytes.subarray(
        Math.min(at, sizes[index]),
        Math.min(at + length, sizes[index])
      )
      if (count !== expected.length) mismatches++
      else if (bytes.some((byte, i) => byte !== expected[i])) mismatches++
      position[index] = at + count
    }
    t.is(mismatches, 0, `iteration ${iteration + 1}`)
  }
})

test('browser read-ahead serves sequential small reads from a window', (t) => {
  t.teardown(() => delete globalThis.FileReaderSync)
  const MiB = 1024 * 1024
  const fixture = readAheadFixture([10 * MiB])
  const { out, position } = readAll(fixture, 0, 10 * MiB, 2048)
  t.is(position, 10 * MiB, 'read to the end')
  t.ok(
    out.every((byte, i) => byte === fixture.files[0].bytes[i]),
    'whole file read back'
  )
  const [first, ...windows] = fixture.calls
  t.alike(first, { direct: true, bytes: 2048 }, 'the first read is direct')
  t.ok(
    windows.every((call) => !call.direct),
    'later reads come from windows'
  )
  t.alike(
    windows.map((call) => call.bytes / 1024),
    [64, 128, 256, 512, 1024, 2048, 4096, 2110],
    'the window doubles to 4 MiB while reads stay sequential'
  )
  t.is(
    fixture.calls.reduce((sum, call) => sum + call.bytes, 0),
    10 * MiB,
    'each byte is fetched once'
  )
  t.is(fixture.read(0, 10 * MiB, 10).count, 0, 'end of file')
})

test('browser read-ahead grows its window for reads that do not line up with it', (t) => {
  t.teardown(() => delete globalThis.FileReaderSync)
  const MiB = 1024 * 1024
  for (const chunk of [2000, 2049, 4095]) {
    const fixture = readAheadFixture([32 * MiB])
    const { out, position } = readAll(fixture, 0, 32 * MiB, chunk)
    t.is(position, 32 * MiB, `${chunk}-byte reads reach the end`)
    t.ok(
      out.every((byte, i) => byte === fixture.files[0].bytes[i]),
      `${chunk}-byte reads return the file`
    )
    t.ok(fixture.calls.length < 20, `${chunk}-byte reads: ${fixture.calls.length} file reads`)
  }
})

test('browser read-ahead never serves one file from another file window', (t) => {
  t.teardown(() => delete globalThis.FileReaderSync)
  const fixture = readAheadFixture([256 * 1024, 256 * 1024])
  fixture.read(0, 0, 1024)
  fixture.read(0, 1024, 1024)
  for (let position = 2048; position < 64 * 1024; position += 1024) {
    const { bytes } = fixture.read(1, position, 1024)
    t.ok(
      bytes.every((byte, i) => byte === fixture.files[1].bytes[position + i]),
      `file 1 at ${position}`
    )
  }
})

test('browser read-ahead reads only the requested bytes for non-sequential reads', (t) => {
  t.teardown(() => delete globalThis.FileReaderSync)
  const MiB = 1024 * 1024
  const fixture = readAheadFixture([8 * MiB])
  for (let position = 8 * MiB - 4096; position >= 0; position -= 64 * 1024) {
    fixture.read(0, position, 2048)
  }
  t.ok(fixture.calls.length > 100)
  t.ok(
    fixture.calls.every((call) => call.direct && call.bytes === 2048),
    'no window fetched for strided reads'
  )
})

test('browser read-ahead releases its window on unmount', (t) => {
  t.teardown(() => delete globalThis.FileReaderSync)
  const fixture = readAheadFixture([256 * 1024])
  fixture.read(0, 0, 1024)
  fixture.read(0, 1024, 1024)
  t.is(fixture.calls.length, 2, 'direct read, then a window')
  fixture.read(0, 4096, 1024)
  t.is(fixture.calls.length, 2, 'served from the window')
  unmountModelFiles(fixture.module, [])
  fixture.read(0, 4096, 1024)
  t.alike(fixture.calls.at(-1), { direct: true, bytes: 1024 }, 'window released')
})

test('browser read-ahead leaves nodes without a sliceable file to the original read', (t) => {
  t.teardown(() => delete globalThis.FileReaderSync)
  globalThis.FileReaderSync = class {
    readAsArrayBuffer() {
      throw new Error('read-ahead used')
    }
  }
  const reads = []
  const ops = {
    read: (_stream, _buffer, _offset, length, position) => reads.push(position) && length
  }
  installReadAhead({ FS: { filesystems: { WORKERFS: { stream_ops: ops } } } })
  const stream = { node: { contents: { bytes: new Uint8Array(1024 * 1024) }, size: 1024 * 1024 } }
  for (let position = 0; position < 64 * 1024; position += 2048) {
    t.is(ops.read(stream, new Int8Array(2048), 0, 2048, position), 2048)
  }
  t.is(reads.length, 32)
})

test('browser read-ahead installs once per engine module', (t) => {
  t.teardown(() => delete globalThis.FileReaderSync)
  const { module } = readAheadFixture([16])
  const wrapped = module.FS.filesystems.WORKERFS.stream_ops.read
  installReadAhead(module)
  t.is(module.FS.filesystems.WORKERFS.stream_ops.read, wrapped)
})

test('browser model mounts install the read-ahead', async (t) => {
  t.teardown(() => delete globalThis[MOUNTED_FILES_KEY])
  installLoadFiles()
  const module = mockModule()
  const direct = module.FS.filesystems.WORKERFS.stream_ops.read
  await mountModelFiles(module, [], '/qvac-files/1', '/models/main.gguf')
  t.not(module.FS.filesystems.WORKERFS.stream_ops.read, direct)
})
