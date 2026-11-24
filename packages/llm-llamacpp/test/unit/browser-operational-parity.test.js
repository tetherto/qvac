'use strict'

const test = require('brittle')
const binding = require('../../binding.browser.js')
const { MOUNTED_FILES_KEY } = require('../../browser/model-files.js')
const {
  CHECKPOINT_COMPLETE_BYTES,
  CHECKPOINT_COMPLETE_FILE,
  hydrateFile,
  hydrateCheckpointTree,
  pathParts,
  persistCompletedTree,
  persistFile,
  persistTree,
  removeMatchingDirectories
} = require('../../browser/persistent-files.js')

let fakeClock = 0
const tick = () => ++fakeClock

function fileBytes(name, bytes, lastModified = tick()) {
  return {
    name,
    lastModified,
    size: bytes.byteLength,
    slice(start, end) {
      const part = bytes.slice(start, end)
      return {
        arrayBuffer: () =>
          Promise.resolve(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength))
      }
    },
    arrayBuffer() {
      return Promise.resolve(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      )
    },
    stream() {
      let offset = 0
      return {
        getReader() {
          return {
            read() {
              if (offset === bytes.byteLength) return Promise.resolve({ done: true })
              const end = Math.min(offset + 3, bytes.byteLength)
              const value = bytes.slice(offset, end)
              offset = end
              return Promise.resolve({ done: false, value })
            },
            releaseLock() {}
          }
        }
      }
    }
  }
}

function trackedFileBytes(name, bytes, state) {
  return {
    name,
    size: bytes.byteLength,
    stream() {
      let offset = 0
      return {
        getReader() {
          return {
            read() {
              if (offset === bytes.byteLength) return Promise.resolve({ done: true })
              const end = Math.min(offset + 3, bytes.byteLength)
              const value = bytes.slice(offset, end)
              offset = end
              return Promise.resolve({ done: false, value })
            },
            cancel() {
              state.cancelCount++
              return Promise.resolve()
            },
            releaseLock() {
              state.releaseCount++
            }
          }
        }
      }
    }
  }
}

function fsError(name) {
  const error = new Error(name)
  error.name = name
  return error
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition was not reached')
}

class FileHandle {
  constructor(name, bytes = new Uint8Array()) {
    this.kind = 'file'
    this.name = name
    this.bytes = bytes
    this.lastModified = tick()
    this.abortCount = 0
    this.activeWritables = 0
    this.maxActiveWritables = 0
    this.createWritableCount = 0
    this.failWrite = null
    this.failCreateWritable = null
    this.failClose = null
    this.writeGate = null
  }

  getFile() {
    return Promise.resolve(fileBytes(this.name, this.bytes, this.lastModified))
  }

  createWritable() {
    this.createWritableCount++
    if (this.failCreateWritable) throw this.failCreateWritable
    const chunks = []
    this.activeWritables++
    this.maxActiveWritables = Math.max(this.maxActiveWritables, this.activeWritables)
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      this.activeWritables--
    }
    return Promise.resolve({
      write: async (chunk) => {
        if (this.failWrite) throw this.failWrite
        if (this.writeGate) await this.writeGate
        chunks.push(new Uint8Array(chunk))
      },
      close: () => {
        if (this.failClose) throw this.failClose
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
        this.bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          this.bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        this.lastModified = tick()
        settle()
        return Promise.resolve()
      },
      abort: () => {
        this.abortCount++
        settle()
        return Promise.resolve()
      }
    })
  }
}

class DirectoryHandle {
  constructor(name = '') {
    this.kind = 'directory'
    this.name = name
    this.children = new Map()
    this.failRemove = null
    this.failDescendantFile = null
  }

  getDirectoryHandle(name, options = {}) {
    const current = this.children.get(name)
    if (current?.kind === 'file') throw fsError('TypeMismatchError')
    if (current) return Promise.resolve(current)
    if (!options.create) throw fsError('NotFoundError')
    const directory = new DirectoryHandle(name)
    directory.failDescendantFile = this.failDescendantFile
    this.children.set(name, directory)
    return Promise.resolve(directory)
  }

  getFileHandle(name, options = {}) {
    const current = this.children.get(name)
    if (current?.kind === 'directory') throw fsError('TypeMismatchError')
    if (current) return Promise.resolve(current)
    if (!options.create) throw fsError('NotFoundError')
    const file = new FileHandle(name)
    if (this.failDescendantFile?.enabled) {
      file.failWrite = this.failDescendantFile.error
      this.failDescendantFile.enabled = false
    }
    this.children.set(name, file)
    return Promise.resolve(file)
  }

  removeEntry(name) {
    if (this.failRemove) throw this.failRemove
    if (!this.children.delete(name)) throw fsError('NotFoundError')
    return Promise.resolve()
  }

  async *entries() {
    yield* this.children.entries()
  }
}

async function opfsDirectory(root, path, create = true) {
  let directory = root
  for (const name of path.split('/').filter(Boolean)) {
    directory = await directory.getDirectoryHandle(name, { create })
  }
  return directory
}

async function opfsWrite(root, path, bytes) {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  const directory = await opfsDirectory(root, parts.join('/'))
  directory.children.set(name, new FileHandle(name, bytes))
}

function committedDirectory(directory) {
  const marker = directory.children.get(CHECKPOINT_COMPLETE_FILE)
  if (!marker) return null
  const bytes = marker.bytes
  if (
    bytes.byteLength === CHECKPOINT_COMPLETE_BYTES.byteLength &&
    bytes.every((value, index) => value === CHECKPOINT_COMPLETE_BYTES[index])
  ) {
    return directory
  }
  const generation = String.fromCharCode(...bytes.subarray(5))
  return directory.children.get(generation) ?? null
}

function generationMarkerBytes(name) {
  const encoded = Uint8Array.from(name, (character) => character.charCodeAt(0))
  const bytes = new Uint8Array(5 + encoded.byteLength)
  bytes.set([81, 86, 65, 67, 2])
  bytes.set(encoded, 5)
  return bytes
}

function memoryFs() {
  const entries = new Map([['/', { kind: 'directory' }]])
  let nextIno = 1
  const fileEntry = (bytes) => ({ kind: 'file', bytes, ino: nextIno++, mtime: tick() })
  function mkdirTree(path) {
    let current = ''
    for (const part of path.split('/').filter(Boolean)) {
      current += `/${part}`
      if (!entries.has(current)) entries.set(current, { kind: 'directory' })
    }
  }
  return {
    mkdirTree,
    open(path, mode) {
      if (mode === 'w') entries.set(path, fileEntry(new Uint8Array()))
      if (!entries.has(path)) throw Object.assign(new Error('missing'), { errno: 44 })
      return { path }
    },
    close() {},
    write(handle, source, offset, length, position) {
      const entry = entries.get(handle.path)
      const next = new Uint8Array(Math.max(entry.bytes.byteLength, position + length))
      next.set(entry.bytes)
      next.set(source.subarray(offset, offset + length), position)
      entry.bytes = next
      entry.mtime = tick()
      return length
    },
    read(handle, target, offset, length, position) {
      const source = entries.get(handle.path).bytes
      const count = Math.min(length, Math.max(0, source.byteLength - position))
      target.set(source.subarray(position, position + count), offset)
      return count
    },
    stat(path) {
      const entry = entries.get(path)
      if (!entry) throw Object.assign(new Error('missing'), { errno: 44 })
      return {
        mode: entry.kind === 'file' ? 1 : 2,
        size: entry.bytes?.byteLength ?? 0,
        ino: entry.ino,
        mtime: entry.mtime
      }
    },
    isFile: (mode) => mode === 1,
    isDir: (mode) => mode === 2,
    readdir(path) {
      const prefix = path === '/' ? '/' : `${path}/`
      const names = new Set(['.', '..'])
      for (const candidate of entries.keys()) {
        if (candidate.startsWith(prefix)) {
          const name = candidate.slice(prefix.length).split('/')[0]
          if (name) names.add(name)
        }
      }
      return [...names]
    },
    unlink: (path) => entries.delete(path),
    rmdir(path) {
      const prefix = `${path}/`
      for (const candidate of entries.keys()) {
        if (candidate.startsWith(prefix)) throw new Error(`directory not empty: ${path}`)
      }
      entries.delete(path)
    },
    bytes: (path) => entries.get(path)?.bytes,
    exists: (path) => entries.has(path),
    set(path, bytes) {
      const slash = path.lastIndexOf('/')
      if (slash > 0) mkdirTree(path.slice(0, slash))
      entries.set(path, fileEntry(new Uint8Array(bytes)))
    }
  }
}

test('browser directory persistence and pause-checkpoint cleanup hold 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const base = `/round-${iteration}`
      const source = Uint8Array.of(iteration, 1, 2, 3, 4, 5, 6)
      const checkpoint = Uint8Array.of(9, 8, 7, iteration)
      const first = { FS: memoryFs() }
      first.FS.set(`${base}/input.bin`, source)
      first.FS.set(`${base}/checkpoints/pause_checkpoint_step_1/state.bin`, source)
      first.FS.set(`${base}/checkpoints/checkpoint_step_2/state.bin`, checkpoint)
      first.FS.set(`${base}/output.bin`, checkpoint)
      t.ok(await persistTree(first, base), `persist tree ${iteration + 1}`)
      const persisted = await opfsDirectory(root, base, false)
      t.alike(
        persisted.children.get('output.bin').bytes,
        checkpoint,
        `persisted bytes ${iteration + 1}`
      )

      await removeMatchingDirectories(first, `${base}/checkpoints`, 'pause_checkpoint_step_')
      t.is(
        first.FS.exists(`${base}/checkpoints/pause_checkpoint_step_1`),
        false,
        `pause removed from memory ${iteration + 1}`
      )
      const checkpoints = await opfsDirectory(root, `${base}/checkpoints`, false)
      t.absent(
        checkpoints.children.get('pause_checkpoint_step_1'),
        `pause removed ${iteration + 1}`
      )
      t.ok(
        checkpoints.children.get('checkpoint_step_2'),
        `periodic checkpoint kept ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser persistence maps relative and absolute paths safely 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const relative = `cache-${iteration}/session.bin`
      const absolute = `/absolute-${iteration}/session.bin`
      const relativeBytes = Uint8Array.of(iteration, 1, 2)
      const absoluteBytes = Uint8Array.of(iteration, 3, 4)
      const module = { FS: memoryFs() }
      module.FS.set(relative, relativeBytes)
      module.FS.set(absolute, absoluteBytes)
      await persistFile(module, relative)
      await persistFile(module, absolute)

      const restored = { FS: memoryFs() }
      t.ok(await hydrateFile(restored, relative), `relative hydrate ${iteration + 1}`)
      t.ok(await hydrateFile(restored, absolute), `absolute hydrate ${iteration + 1}`)
      t.alike(restored.FS.bytes(relative), relativeBytes, `relative bytes ${iteration + 1}`)
      t.alike(restored.FS.bytes(absolute), absoluteBytes, `absolute bytes ${iteration + 1}`)
    }
    for (const invalid of [
      '',
      '/',
      '.',
      '..',
      'cache/../escape.bin',
      '/cache/./file.bin',
      'cache/..\0suffix/file.bin'
    ]) {
      let error = null
      try {
        pathParts(invalid)
      } catch (cause) {
        error = cause
      }
      t.ok(error instanceof TypeError && /Invalid OPFS path/.test(error.message), invalid)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser persistence copies to OPFS only when either side changed 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `/unchanged-${iteration}/session.bin`
      const module = { FS: memoryFs() }
      module.FS.set(path, Uint8Array.of(1, 2, iteration))
      await persistFile(module, path)
      const directory = await opfsDirectory(root, `unchanged-${iteration}`, false)
      const handle = directory.children.get('session.bin')
      t.is(handle.createWritableCount, 1, `first copy written ${iteration + 1}`)

      await persistFile(module, path)
      await persistTree(module, path)
      t.is(handle.createWritableCount, 1, `unchanged copy skipped ${iteration + 1}`)

      const source = module.FS.open(path, 'r')
      module.FS.write(source, Uint8Array.of(9), 0, 1, 0)
      module.FS.close(source)
      await persistFile(module, path)
      t.is(handle.createWritableCount, 2, `in-place MEMFS write copied ${iteration + 1}`)
      t.alike(handle.bytes, Uint8Array.of(9, 2, iteration), `new bytes copied ${iteration + 1}`)

      module.FS.set(path, Uint8Array.of(9, 2, iteration))
      await persistFile(module, path)
      t.is(handle.createWritableCount, 3, `replaced MEMFS file copied ${iteration + 1}`)

      await opfsWrite(root, path, Uint8Array.of(7, 7, 7))
      await persistFile(module, path)
      const replaced = directory.children.get('session.bin')
      t.alike(
        replaced.bytes,
        Uint8Array.of(9, 2, iteration),
        `external OPFS change overwritten ${iteration + 1}`
      )

      await directory.removeEntry('session.bin')
      await persistFile(module, path)
      t.alike(
        directory.children.get('session.bin')?.bytes,
        Uint8Array.of(9, 2, iteration),
        `deleted OPFS file rewritten ${iteration + 1}`
      )

      const restored = { FS: memoryFs() }
      t.ok(await hydrateFile(restored, path), `hydrated ${iteration + 1}`)
      const hydratedHandle = directory.children.get('session.bin')
      const writes = hydratedHandle.createWritableCount
      await persistFile(restored, path)
      t.is(hydratedHandle.createWritableCount, writes, `hydrated copy skipped ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser persistence uses canonical cross-context Web Locks 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  const tails = new Map()
  const requested = []
  const locks = {
    request(name, task) {
      requested.push(name)
      const previous = tails.get(name) ?? Promise.resolve()
      const result = previous.catch(() => {}).then(task)
      const settled = result
        .catch(() => {})
        .finally(() => {
          if (tails.get(name) === settled) tails.delete(name)
        })
      tails.set(name, settled)
      return result
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks, storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `web-lock-${iteration}/state.bin`
      const aliases = [path, `/${path}`, `/web-lock-${iteration}//state.bin`]
      const modules = aliases.map((alias, index) => {
        const module = { FS: memoryFs() }
        module.FS.set(alias, Uint8Array.of(index + 1, iteration))
        return module
      })
      const start = requested.length
      await Promise.all(aliases.map((alias, index) => persistFile(modules[index], alias)))
      t.alike(
        requested.slice(start),
        Array(3).fill(`qvac-opfs:${path}`),
        `canonical lock name ${iteration + 1}`
      )
      const directory = await opfsDirectory(root, `web-lock-${iteration}`, false)
      const file = directory.children.get('state.bin')
      t.is(file.maxActiveWritables, 1, `cross-context writers serialized ${iteration + 1}`)
      t.alike(file.bytes, Uint8Array.of(3, iteration), `last writer committed ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser persistence aborts failed writes and serializes same-path callers', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `concurrent-${iteration}/state.bin`
      const absoluteAlias = `/${path}`
      const repeatedSlashAlias = `/concurrent-${iteration}//state.bin`
      const first = { FS: memoryFs() }
      const second = { FS: memoryFs() }
      const third = { FS: memoryFs() }
      first.FS.set(path, Uint8Array.of(1, iteration))
      second.FS.set(absoluteAlias, Uint8Array.of(2, iteration))
      third.FS.set(repeatedSlashAlias, Uint8Array.of(3, iteration))
      await Promise.all([
        persistFile(first, path),
        persistFile(second, absoluteAlias),
        persistFile(third, repeatedSlashAlias)
      ])
      const directory = await opfsDirectory(root, `concurrent-${iteration}`, false)
      const handle = directory.children.get('state.bin')
      t.alike(handle.bytes, Uint8Array.of(3, iteration), `last alias writer ${iteration + 1}`)
      t.is(handle.maxActiveWritables, 1, `serialized writers ${iteration + 1}`)

      handle.failWrite = fsError('QuotaExceededError')
      first.FS.set(path, Uint8Array.of(4, iteration))
      let failure = null
      try {
        await persistFile(first, path)
      } catch (error) {
        failure = error
      }
      t.is(failure && failure.name, 'QuotaExceededError', `quota failure ${iteration + 1}`)
      t.alike(handle.bytes, Uint8Array.of(3, iteration), `old bytes preserved ${iteration + 1}`)
      t.is(handle.abortCount, 1, `failed writer aborted ${iteration + 1}`)
      handle.failWrite = null
      third.FS.set(repeatedSlashAlias, Uint8Array.of(5, iteration))
      await persistFile(third, repeatedSlashAlias)
      t.alike(handle.bytes, Uint8Array.of(5, iteration), `rejected tail recovered ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser persistence recovers when the MEMFS source cannot be opened 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `/source-open-${iteration}/state.bin`
      const bytes = Uint8Array.of(1, 2, iteration)
      const module = { FS: memoryFs() }
      module.FS.set(path, bytes)
      const open = module.FS.open
      const close = module.FS.close
      let failOpen = true
      let failClose = false
      module.FS.open = (candidate, mode) => {
        if (failOpen && candidate === path && mode === 'r') {
          failOpen = false
          throw new Error('injected source open failure')
        }
        return open(candidate, mode)
      }
      module.FS.close = (handle) => {
        if (failClose) {
          failClose = false
          throw new Error('injected source close failure')
        }
        return close(handle)
      }

      await t.exception.all(
        () => persistFile(module, path),
        /injected source open failure/,
        `source failure surfaced ${iteration + 1}`
      )
      const directory = await opfsDirectory(root, `/source-open-${iteration}`, false).catch(
        () => null
      )
      t.is(directory, null, `no destination acquired ${iteration + 1}`)

      failClose = true
      await t.exception.all(
        () => persistFile(module, path),
        /injected source close failure/,
        `sole close failure surfaced ${iteration + 1}`
      )
      const recovered = await opfsDirectory(root, `/source-open-${iteration}`, false)
      const handle = recovered.children.get('state.bin')
      handle.failWrite = fsError('QuotaExceededError')
      failClose = true
      await t.exception.all(
        () => persistFile(module, path),
        /QuotaExceededError/,
        `primary write failure preserved ${iteration + 1}`
      )
      handle.failWrite = null

      await persistFile(module, path)
      t.alike(handle.bytes, bytes, `same-path retry persisted ${iteration + 1}`)
      t.is(handle.activeWritables, 0, `no writable leaked ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('new browser persistence destinations are removed after failed commits 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      for (const failure of ['failCreateWritable', 'failWrite', 'failClose']) {
        const directoryPath = `/new-destination-${iteration}-${failure}`
        const path = `${directoryPath}/state.bin`
        const bytes = Uint8Array.of(5, iteration)
        const directory = await opfsDirectory(root, directoryPath)
        const getFileHandle = directory.getFileHandle.bind(directory)
        let inject = true
        directory.getFileHandle = async (name, options) => {
          const handle = await getFileHandle(name, options)
          if (inject && options?.create) {
            handle[failure] = fsError('QuotaExceededError')
            inject = false
          }
          return handle
        }
        const module = { FS: memoryFs() }
        module.FS.set(path, bytes)

        await t.exception.all(
          () => persistFile(module, path),
          /QuotaExceededError/,
          `${failure} surfaced ${iteration + 1}`
        )
        t.absent(directory.children.get('state.bin'), `${failure} entry removed ${iteration + 1}`)
        const restarted = { FS: memoryFs() }
        t.is(
          await hydrateFile(restarted, path),
          false,
          `${failure} restart refused ${iteration + 1}`
        )

        await persistFile(module, path)
        t.alike(
          directory.children.get('state.bin').bytes,
          bytes,
          `${failure} retry recovered ${iteration + 1}`
        )
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser hydration releases a mounted-file reader when MEMFS open fails 20x', async (t) => {
  const mountedDescriptor = Object.getOwnPropertyDescriptor(globalThis, MOUNTED_FILES_KEY)
  const mounted = new Map()
  globalThis[MOUNTED_FILES_KEY] = mounted
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `/hydrate-open-${iteration}/state.bin`
      const bytes = Uint8Array.of(3, 4, iteration)
      const readerState = { cancelCount: 0, releaseCount: 0 }
      mounted.set(path, trackedFileBytes('state.bin', bytes, readerState))
      const module = { FS: memoryFs() }
      const open = module.FS.open
      const close = module.FS.close
      let failOpen = true
      let failClose = false
      module.FS.open = (candidate, mode) => {
        if (failOpen && candidate === path && mode === 'w') {
          failOpen = false
          throw new Error('injected target open failure')
        }
        return open(candidate, mode)
      }
      module.FS.close = (handle) => {
        if (failClose) {
          failClose = false
          throw new Error('injected target close failure')
        }
        return close(handle)
      }

      await t.exception.all(
        () => hydrateFile(module, path),
        /injected target open failure/,
        `target failure surfaced ${iteration + 1}`
      )
      t.is(readerState.cancelCount, 1, `reader cancelled ${iteration + 1}`)
      t.is(readerState.releaseCount, 1, `reader released ${iteration + 1}`)

      failClose = true
      await t.exception.all(
        () => hydrateFile(module, path),
        /injected target close failure/,
        `close failure surfaced ${iteration + 1}`
      )
      t.is(readerState.releaseCount, 2, `reader released after close failure ${iteration + 1}`)

      t.ok(await hydrateFile(module, path), `same-path retry hydrated ${iteration + 1}`)
      t.alike(module.FS.bytes(path), bytes, `retry bytes ${iteration + 1}`)
      t.is(readerState.releaseCount, 3, `retry reader released ${iteration + 1}`)
    }
  } finally {
    if (mountedDescriptor) {
      Object.defineProperty(globalThis, MOUNTED_FILES_KEY, mountedDescriptor)
    } else {
      delete globalThis[MOUNTED_FILES_KEY]
    }
  }
})

test('mounted browser files reject traversal before touching MEMFS 20x', async (t) => {
  const mountedDescriptor = Object.getOwnPropertyDescriptor(globalThis, MOUNTED_FILES_KEY)
  const mounted = new Map()
  globalThis[MOUNTED_FILES_KEY] = mounted
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `/mounted-${iteration}/../sentinel.bin`
      mounted.set(path, fileBytes('sentinel.bin', Uint8Array.of(iteration)))
      const module = { FS: memoryFs() }
      module.FS.set('/sentinel.bin', Uint8Array.of(9, iteration))
      let openCalls = 0
      const open = module.FS.open
      module.FS.open = (...args) => {
        openCalls++
        return open(...args)
      }

      await t.exception.all(
        () => hydrateFile(module, path),
        /Invalid OPFS path/,
        `mounted traversal rejected ${iteration + 1}`
      )
      t.is(openCalls, 0, `MEMFS was not opened ${iteration + 1}`)
      t.alike(
        module.FS.bytes('/sentinel.bin'),
        Uint8Array.of(9, iteration),
        `sentinel untouched ${iteration + 1}`
      )
    }
  } finally {
    if (mountedDescriptor) {
      Object.defineProperty(globalThis, MOUNTED_FILES_KEY, mountedDescriptor)
    } else {
      delete globalThis[MOUNTED_FILES_KEY]
    }
  }
})

test('browser checkpoint hydration ignores incomplete directories 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const base = `/checkpoint-recovery-${iteration}`
      const complete = `${base}/pause_checkpoint_step_00000001`
      const partial = `${base}/pause_checkpoint_step_00000002`
      await opfsWrite(root, `${complete}/model.gguf`, Uint8Array.of(1, iteration))
      await opfsWrite(root, `${complete}/${CHECKPOINT_COMPLETE_FILE}`, CHECKPOINT_COMPLETE_BYTES)
      await opfsWrite(root, `${partial}/model.gguf`, Uint8Array.of(2, iteration))

      const module = { FS: memoryFs() }
      module.FS.set(`${partial}/model.gguf`, Uint8Array.of(9, iteration))
      t.ok(await hydrateCheckpointTree(module, base), `checkpoint root ${iteration + 1}`)
      t.ok(module.FS.exists(`${complete}/model.gguf`), `complete restored ${iteration + 1}`)
      t.is(module.FS.exists(`${partial}/model.gguf`), false, `partial skipped ${iteration + 1}`)
      t.is(
        module.FS.exists(`${complete}/${CHECKPOINT_COMPLETE_FILE}`),
        false,
        `marker stays outside MEMFS ${iteration + 1}`
      )

      module.FS.set(`${partial}/model.gguf`, Uint8Array.of(3, iteration))
      await persistCompletedTree(module, partial)
      const restarted = { FS: memoryFs() }
      await hydrateCheckpointTree(restarted, base)
      t.alike(
        restarted.FS.bytes(`${partial}/model.gguf`),
        Uint8Array.of(3, iteration),
        `completed tree restored ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('invalid and orphan checkpoint generations preserve pending MEMFS state 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const checkpointRoot = `/invalid-generations-${iteration}`
      await opfsWrite(
        root,
        `${checkpointRoot}/malformed/${CHECKPOINT_COMPLETE_FILE}`,
        generationMarkerBytes('../escape')
      )
      await opfsWrite(
        root,
        `${checkpointRoot}/missing/${CHECKPOINT_COMPLETE_FILE}`,
        generationMarkerBytes('.qvac-data-missing')
      )
      await opfsWrite(
        root,
        `${checkpointRoot}/orphan/.qvac-data-orphan/state.bin`,
        Uint8Array.of(7, iteration)
      )
      const module = { FS: memoryFs() }
      const sentinel = `${checkpointRoot}/pending/state.bin`
      module.FS.set(sentinel, Uint8Array.of(9, iteration))

      t.ok(await hydrateCheckpointTree(module, checkpointRoot), `root scanned ${iteration + 1}`)
      t.alike(
        module.FS.bytes(sentinel),
        Uint8Array.of(9, iteration),
        `pending state preserved ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser checkpoint replacement preserves the prior generation on failure 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const checkpointRoot = `/atomic-checkpoints-${iteration}`
      const checkpoint = `${checkpointRoot}/checkpoint_step_1`
      const modelPath = `${checkpoint}/model.gguf`
      const markerPath = `${checkpoint}/${CHECKPOINT_COMPLETE_FILE}`
      const oldBytes = Uint8Array.of(1, iteration)
      const newBytes = Uint8Array.of(2, iteration)
      await opfsWrite(root, modelPath, oldBytes)
      await opfsWrite(root, markerPath, CHECKPOINT_COMPLETE_BYTES)
      await opfsWrite(
        root,
        `${checkpoint}/.qvac-data-orphan/model.gguf`,
        Uint8Array.of(99, iteration)
      )
      const directory = await opfsDirectory(root, checkpoint, false)
      directory.failDescendantFile = { enabled: true, error: fsError('QuotaExceededError') }

      const module = { FS: memoryFs() }
      module.FS.set(modelPath, newBytes)
      await t.exception.all(
        () => persistCompletedTree(module, checkpoint),
        /QuotaExceededError/,
        `checkpoint write failed ${iteration + 1}`
      )
      t.alike(
        directory.children.get(CHECKPOINT_COMPLETE_FILE).bytes,
        CHECKPOINT_COMPLETE_BYTES,
        `old marker preserved ${iteration + 1}`
      )

      t.ok(
        await hydrateCheckpointTree(module, checkpointRoot),
        `same-module recovery scanned ${iteration + 1}`
      )
      t.alike(
        module.FS.bytes(modelPath),
        oldBytes,
        `same-module old bytes restored ${iteration + 1}`
      )
      const restarted = { FS: memoryFs() }
      t.ok(
        await hydrateCheckpointTree(restarted, checkpointRoot),
        `restart recovery scanned ${iteration + 1}`
      )
      t.alike(
        restarted.FS.bytes(modelPath),
        oldBytes,
        `restart old bytes restored ${iteration + 1}`
      )

      module.FS.set(modelPath, newBytes)
      await persistCompletedTree(module, checkpoint)
      t.ok(directory.children.get(CHECKPOINT_COMPLETE_FILE), `retry marked ${iteration + 1}`)
      t.absent(directory.children.get('.qvac-data-orphan'), `orphan removed ${iteration + 1}`)
      const recovered = { FS: memoryFs() }
      await hydrateCheckpointTree(recovered, checkpointRoot)
      t.alike(recovered.FS.bytes(modelPath), newBytes, `retry bytes ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser checkpoint markers cannot survive incomplete commits 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const checkpointRoot = `/marker-checkpoints-${iteration}`
      const checkpoint = `${checkpointRoot}/checkpoint_step_1`
      const modelPath = `${checkpoint}/model.gguf`
      const module = { FS: memoryFs() }
      module.FS.set(modelPath, Uint8Array.of(7, iteration))
      const directory = await opfsDirectory(root, checkpoint)
      const getFileHandle = directory.getFileHandle.bind(directory)
      let markerFailure = null
      directory.getFileHandle = async (name, options) => {
        const handle = await getFileHandle(name, options)
        if (name === CHECKPOINT_COMPLETE_FILE && markerFailure) {
          handle[markerFailure] = fsError('QuotaExceededError')
          markerFailure = null
        }
        return handle
      }

      for (const failure of ['failCreateWritable', 'failClose']) {
        markerFailure = failure
        await t.exception.all(
          () => persistCompletedTree(module, checkpoint),
          /QuotaExceededError/,
          `${failure} surfaced ${iteration + 1}`
        )
        t.absent(
          directory.children.get(CHECKPOINT_COMPLETE_FILE),
          `${failure} marker removed ${iteration + 1}`
        )
        const restarted = { FS: memoryFs() }
        await hydrateCheckpointTree(restarted, checkpointRoot)
        t.is(
          restarted.FS.exists(modelPath),
          false,
          `${failure} checkpoint refused ${iteration + 1}`
        )
      }

      await persistCompletedTree(module, checkpoint)
      const marker = directory.children.get(CHECKPOINT_COMPLETE_FILE)
      t.ok(marker.bytes.byteLength > 5, `valid marker committed ${iteration + 1}`)
      const recovered = { FS: memoryFs() }
      await hydrateCheckpointTree(recovered, checkpointRoot)
      t.alike(
        recovered.FS.bytes(modelPath),
        Uint8Array.of(7, iteration),
        `checkpoint recovered ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser checkpoint persistence is optional without OPFS 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  delete globalThis.navigator
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      t.is(
        await persistCompletedTree({}, `/checkpoints-${iteration}`),
        false,
        `no persistence ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  }
})

test('missing checkpoint trees never receive completion markers 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `/missing-checkpoints-${iteration}/checkpoint_step_1`
      const module = { FS: memoryFs() }
      module.FS.set(`${path}/sentinel.bin`, Uint8Array.of(iteration))
      const source = { FS: memoryFs() }
      t.is(await persistCompletedTree(source, path), false, `missing ${iteration + 1}`)
      const directory = await opfsDirectory(root, `/missing-checkpoints-${iteration}`, false).catch(
        () => null
      )
      t.is(directory, null, `no marker directory ${iteration + 1}`)
      t.is(
        await hydrateCheckpointTree(module, `/missing-checkpoints-${iteration}`),
        false,
        `missing hydrate source ${iteration + 1}`
      )
      t.ok(module.FS.exists(`${path}/sentinel.bin`), `MEMFS preserved ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('missing MEMFS checkpoint sources preserve existing durable checkpoints 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const checkpointRoot = `/durable-checkpoints-${iteration}`
      const checkpoint = `${checkpointRoot}/checkpoint_step_1`
      const modelPath = `${checkpoint}/model.gguf`
      const markerPath = `${checkpoint}/${CHECKPOINT_COMPLETE_FILE}`
      const bytes = Uint8Array.of(8, iteration)
      await opfsWrite(root, modelPath, bytes)
      await opfsWrite(root, markerPath, CHECKPOINT_COMPLETE_BYTES)

      t.is(
        await persistCompletedTree({ FS: memoryFs() }, checkpoint),
        false,
        `missing source refused ${iteration + 1}`
      )
      const directory = await opfsDirectory(root, checkpoint, false)
      t.alike(
        directory.children.get(CHECKPOINT_COMPLETE_FILE).bytes,
        CHECKPOINT_COMPLETE_BYTES,
        `marker preserved ${iteration + 1}`
      )
      const restarted = { FS: memoryFs() }
      await hydrateCheckpointTree(restarted, checkpointRoot)
      t.alike(restarted.FS.bytes(modelPath), bytes, `old checkpoint restored ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser checkpoint helpers reject traversal before mutating MEMFS 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const invalid = `/checkpoints-${iteration}/../cache`
      const checkpoint = `${invalid}/pause_checkpoint_step_1/state.bin`
      for (const operation of [
        (module) => hydrateCheckpointTree(module, invalid),
        (module) => removeMatchingDirectories(module, invalid, 'pause_checkpoint_step_')
      ]) {
        const module = { FS: memoryFs() }
        module.FS.set(checkpoint, Uint8Array.of(iteration))
        let failure = null
        try {
          await operation(module)
        } catch (error) {
          failure = error
        }
        t.ok(failure instanceof TypeError, `traversal rejected ${iteration + 1}`)
        t.ok(module.FS.exists(checkpoint), `sentinel untouched ${iteration + 1}`)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

function fitValidationEngine() {
  const mounted = new Map()
  let result = '{}'
  return {
    FS: {
      filesystems: { WORKERFS: {} },
      mkdirTree() {},
      mount(_type, { files }, mountpoint) {
        for (const file of files) mounted.set(`${mountpoint}/${file.name}`, file)
      },
      unmount(mountpoint) {
        for (const path of mounted.keys()) {
          if (path.startsWith(`${mountpoint}/`)) mounted.delete(path)
        }
      },
      rmdir() {}
    },
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_validate_fit') {
        return (async () => {
          const file = mounted.get(args[0])
          const header = new Uint8Array(await file.slice(0, 8).arrayBuffer())
          const config = JSON.parse(args[1])
          if (header.byteLength < 8 || String.fromCharCode(...header.slice(0, 4)) !== 'GGUF') {
            result = JSON.stringify({ error: 'invalid GGUF header', code: 'INVALID_ARGUMENT' })
            return -1
          }
          if (config.ctx_size === 'not-a-number') {
            result = JSON.stringify({ error: 'invalid ctx_size', code: 'INVALID_ARGUMENT' })
            return -1
          }
          return 0
        })()
      }
      if (name === 'qvac_web_result') return result
      return 0
    }
  }
}

test('browser assessFit validates through the engine and reports unknown', async (t) => {
  const previous = globalThis[MOUNTED_FILES_KEY]
  const mounted = new Map()
  globalThis[MOUNTED_FILES_KEY] = mounted
  binding._setEngineFactoryForTest(fitValidationEngine)
  try {
    mounted.set(
      '/models/model.gguf',
      fileBytes('model.gguf', Uint8Array.from([71, 71, 85, 70, 3, 0, 0, 0]))
    )
    const result = await binding.assessFit({
      modelPath: '/models/model.gguf',
      config: { ctx_size: '256' }
    })
    t.alike(result, { status: 'unknown', devices: [], stats: {} })

    for (const bytes of [Uint8Array.of(71, 71, 85, 70), Uint8Array.of(66, 65, 68, 33)]) {
      mounted.set('/models/bad.gguf', fileBytes('bad.gguf', bytes))
      await t.exception.all(
        () => binding.assessFit({ modelPath: '/models/bad.gguf' }),
        /invalid GGUF header/
      )
    }
    await t.exception.all(
      () => binding.assessFit({ modelPath: '/models/model.gguf', marginBytes: Infinity }),
      /non-negative finite number/
    )
    await t.exception.all(
      () =>
        binding.assessFit({
          modelPath: '/models/model.gguf',
          config: { ctx_size: 'not-a-number' }
        }),
      /invalid ctx_size/
    )
    for (const value of [256, null, true]) {
      await t.exception.all(
        () => binding.assessFit({ modelPath: '/models/model.gguf', config: { ctx_size: value } }),
        /config.ctx_size must be a string/
      )
    }
  } finally {
    if (previous === undefined) delete globalThis[MOUNTED_FILES_KEY]
    else globalThis[MOUNTED_FILES_KEY] = previous
  }
})

test('browser assessFit retires an engine whose temporary mount cannot be cleaned 20x', async (t) => {
  const previous = globalThis[MOUNTED_FILES_KEY]
  const mounted = new Map()
  globalThis[MOUNTED_FILES_KEY] = mounted
  mounted.set(
    '/models/model.gguf',
    fileBytes('model.gguf', Uint8Array.from([71, 71, 85, 70, 3, 0, 0, 0]))
  )
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      let factoryCalls = 0
      binding._setEngineFactoryForTest(() => {
        factoryCalls++
        const engine = fitValidationEngine()
        if (factoryCalls === 1) {
          engine.FS.unmount = () => {
            throw new Error('injected unmount failure')
          }
        }
        return engine
      })
      await t.exception.all(
        () => binding.assessFit({ modelPath: '/models/model.gguf' }),
        /injected unmount failure/,
        `cleanup failure surfaced ${iteration + 1}`
      )
      t.alike(
        await binding.assessFit({ modelPath: '/models/model.gguf' }),
        { status: 'unknown', devices: [], stats: {} },
        `fresh engine succeeds ${iteration + 1}`
      )
      t.is(factoryCalls, 2, `failed engine retired ${iteration + 1}`)
    }
  } finally {
    if (previous === undefined) delete globalThis[MOUNTED_FILES_KEY]
    else globalThis[MOUNTED_FILES_KEY] = previous
  }
})

function finetuneEngine(options) {
  return {
    FS: memoryFs(),
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_finetune') {
        const params = JSON.parse(args[2])
        if (params.learningRate === null) throw new TypeError('learningRate must be a number')
        return new Promise((resolve) => {
          const poll = () => {
            const mode = options.qvacCancelMode(args[0], args[1])
            if (mode === 0) return setTimeout(poll, 0)
            options.qvacEmit(
              args[0],
              args[1],
              'JobEnded',
              JSON.stringify({ op: 'finetune', status: 'PAUSED' })
            )
            options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
            resolve(0)
          }
          options.qvacEmit(
            args[0],
            args[1],
            'FinetuneProgress',
            JSON.stringify({ stats: { global_steps: 1 } })
          )
          poll()
        })
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }
}

function cancellingFinetuneEngine(options) {
  let nextHandle = 1
  return {
    FS: memoryFs(),
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return nextHandle++
      if (name === 'qvac_web_finetune') {
        return new Promise((resolve) => {
          options.qvacEmit(
            args[0],
            args[1],
            'FinetuneProgress',
            JSON.stringify({ stats: { global_steps: 1 } })
          )
          const poll = () => {
            if (options.qvacCancelMode(args[0], args[1]) === 0) return setTimeout(poll, 0)
            options.qvacEmit(
              args[0],
              args[1],
              'JobEnded',
              JSON.stringify({ op: 'finetune', status: 'PAUSED' })
            )
            options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
            resolve(0)
          }
          poll()
        })
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }
}

test('no-save finetune termination removes stale pause checkpoints 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(cancellingFinetuneEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      for (const callbackFailure of [false, true]) {
        const suffix = `${callbackFailure ? 'callback' : 'direct'}-${iteration}`
        const checkpointRoot = `/terminal-cancel-${suffix}`
        const pause = `${checkpointRoot}/pause_checkpoint_step_1`
        await opfsWrite(root, `${pause}/state.bin`, Uint8Array.of(1, iteration))
        await opfsWrite(root, `${pause}/${CHECKPOINT_COMPLETE_FILE}`, CHECKPOINT_COMPLETE_BYTES)
        const handle = binding.createInstance({}, { path: '', config: {} }, (_owner, event) => {
          if (callbackFailure && event === 'FinetuneProgress') {
            throw new Error('progress callback failed')
          }
        })
        await binding.activate(handle)
        const id = await binding.finetune(handle, {
          trainDatasetDir: `/terminal-train-${suffix}.jsonl`,
          outputParametersDir: `/terminal-output-${suffix}`,
          checkpointSaveDir: checkpointRoot
        })
        if (!callbackFailure) await binding.cancelJob(handle, id)
        await eventually(() => binding.activeJobs(handle) === 0)

        const checkpointDirectory = await opfsDirectory(root, checkpointRoot, false)
        t.absent(
          checkpointDirectory.children.get('pause_checkpoint_step_1'),
          `durable pause removed ${suffix}`
        )
        t.absent(
          handle.engine.module.FS.exists(`${pause}/state.bin`),
          `MEMFS pause removed ${suffix}`
        )
        await binding.destroyInstance(handle)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('unload preserves a resumable pause checkpoint while cancelling active finetune 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(cancellingFinetuneEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const checkpointRoot = `/unload-cancel-${iteration}`
      const pause = `${checkpointRoot}/pause_checkpoint_step_1`
      const state = Uint8Array.of(7, iteration)
      await opfsWrite(root, `${pause}/state.bin`, state)
      await opfsWrite(root, `${pause}/${CHECKPOINT_COMPLETE_FILE}`, CHECKPOINT_COMPLETE_BYTES)
      const handle = binding.createInstance({}, { path: '', config: {} }, () => {})
      await binding.activate(handle)
      await binding.finetune(handle, {
        trainDatasetDir: `/unload-train-${iteration}.jsonl`,
        outputParametersDir: `/unload-output-${iteration}`,
        checkpointSaveDir: checkpointRoot
      })

      await binding.destroyInstance(handle)

      const checkpointDirectory = await opfsDirectory(root, checkpointRoot, false)
      const retainedPause = checkpointDirectory.children.get('pause_checkpoint_step_1')
      t.ok(retainedPause, `durable pause retained ${iteration + 1}`)
      t.alike(
        retainedPause.children.get('state.bin').bytes,
        state,
        `durable pause content retained ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser finetune rejects unsafe persistent paths before admission 20x', async (t) => {
  binding._setEngineFactoryForTest(finetuneEngine)
  const keys = [
    'trainDatasetDir',
    'outputParametersDir',
    'checkpointSaveDir',
    'evalDatasetPath',
    'chatTemplatePath'
  ]
  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = binding.createInstance(
      {},
      { path: '', projectionPath: '', config: {} },
      () => {}
    )
    await binding.activate(handle)
    for (const key of keys) {
      for (const unsafe of [`/unsafe-${iteration}/../escape`, `/unsafe-${iteration}/..\0suffix`]) {
        const params = {
          trainDatasetDir: `/train-${iteration}.jsonl`,
          outputParametersDir: `/output-${iteration}`,
          checkpointSaveDir: `/checkpoints-${iteration}`,
          [key]: unsafe
        }
        let failure = null
        try {
          await binding.finetune(handle, params)
        } catch (error) {
          failure = error
        }
        t.ok(failure instanceof TypeError, `${key} rejected ${iteration + 1}`)
        t.is(binding.activeJobs(handle), 0, `${key} not admitted ${iteration + 1}`)
        t.is(handle.checkpointSaveDir, null, `${key} has no side effect ${iteration + 1}`)
      }
    }
    for (const value of [null, 0, false]) {
      let failure = null
      try {
        await binding.finetune(handle, {
          trainDatasetDir: `/train-${iteration}.jsonl`,
          outputParametersDir: `/output-${iteration}`,
          checkpointSaveDir: value
        })
      } catch (error) {
        failure = error
      }
      t.ok(failure instanceof TypeError, `checkpoint type ${String(value)} rejected`)
      t.is(binding.activeJobs(handle), 0, `checkpoint type not admitted ${String(value)}`)
      t.is(handle.checkpointSaveDir, null, `checkpoint type has no side effect ${String(value)}`)
    }
    await binding.destroyInstance(handle)
  }
})

test('browser finetune rejects null and non-finite numeric options 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(finetuneEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
        const events = []
        const handle = binding.createInstance(
          {},
          { path: '', projectionPath: '', config: {} },
          (_owner, event, _data, error) => events.push({ event, error })
        )
        await binding.activate(handle)
        await binding.finetune(handle, {
          trainDatasetDir: `/numeric-train-${iteration}.jsonl`,
          outputParametersDir: `/numeric-output-${iteration}`,
          learningRate: value
        })
        await eventually(() => binding.activeJobs(handle) === 0)
        t.is(events.at(-1).event, 'Error', `${String(value)} rejected ${iteration + 1}`)
        t.ok(
          events.at(-1).error instanceof TypeError,
          `${String(value)} type error ${iteration + 1}`
        )
        await binding.destroyInstance(handle)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser binding retries only failed exact checkpoint callbacks 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(checkpointRetryEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const base = `/binding-checkpoints-${iteration}`

      const success = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        () => {}
      )
      await binding.activate(success)
      await binding.finetune(success, {
        trainDatasetDir: `/binding-train-success-${iteration}.jsonl`,
        outputParametersDir: `/binding-output-success-${iteration}`,
        checkpointSaveDir: `${base}/success`,
        checkpointKind: 'checkpoint'
      })
      await eventually(() => binding.activeJobs(success) === 0)
      const successDirectory = await opfsDirectory(root, `${base}/success/checkpoint_step_1`, false)
      const successState = committedDirectory(successDirectory).children.get('state.bin')
      t.is(successState.createWritableCount, 1, `successful callback written once ${iteration + 1}`)
      await binding.destroyInstance(success)
      t.is(
        successState.createWritableCount,
        1,
        `successful callback not rewritten ${iteration + 1}`
      )

      const periodicPath = `${base}/retry/checkpoint_step_1`
      await opfsWrite(root, `${periodicPath}/state.bin`, Uint8Array.of(0))
      const periodicDirectory = await opfsDirectory(root, periodicPath, false)
      periodicDirectory.failDescendantFile = {
        enabled: true,
        error: fsError('QuotaExceededError')
      }
      const periodic = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        () => {}
      )
      await binding.activate(periodic)
      await binding.finetune(periodic, {
        trainDatasetDir: `/binding-train-retry-${iteration}.jsonl`,
        outputParametersDir: `/binding-output-retry-${iteration}`,
        checkpointSaveDir: `${base}/retry`,
        checkpointKind: 'checkpoint'
      })
      await eventually(() => binding.activeJobs(periodic) === 0)
      await binding.destroyInstance(periodic)
      t.ok(
        committedDirectory(periodicDirectory),
        `failed periodic callback retried ${iteration + 1}`
      )

      const pausePath = `${base}/cancel/pause_checkpoint_step_1`
      await opfsWrite(root, `${pausePath}/state.bin`, Uint8Array.of(0))
      const pauseDirectory = await opfsDirectory(root, pausePath, false)
      pauseDirectory.failDescendantFile = {
        enabled: true,
        error: fsError('QuotaExceededError')
      }
      const pause = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        () => {}
      )
      await binding.activate(pause)
      await binding.finetune(pause, {
        trainDatasetDir: `/binding-train-cancel-${iteration}.jsonl`,
        outputParametersDir: `/binding-output-cancel-${iteration}`,
        checkpointSaveDir: `${base}/cancel`,
        checkpointKind: 'pause_checkpoint'
      })
      await eventually(() => binding.activeJobs(pause) === 0)
      await binding.cancel(pause, 0)
      await binding.destroyInstance(pause)
      const cancelRoot = await opfsDirectory(root, `${base}/cancel`, false)
      t.absent(
        cancelRoot.children.get('pause_checkpoint_step_1'),
        `cancelled failed pause forgotten ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('a later finetune retries pending checkpoints before hydrating the same root 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(checkpointRetryEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const checkpointRoot = `/same-root-retry-${iteration}`
      const firstPath = `${checkpointRoot}/checkpoint_step_1`
      await opfsWrite(root, `${firstPath}/state.bin`, Uint8Array.of(0))
      const firstDirectory = await opfsDirectory(root, firstPath, false)
      firstDirectory.failDescendantFile = {
        enabled: true,
        error: fsError('QuotaExceededError')
      }
      const handle = binding.createInstance({}, { path: '', config: {} }, () => {})
      await binding.activate(handle)
      await binding.finetune(handle, {
        trainDatasetDir: `/same-root-train-${iteration}.jsonl`,
        outputParametersDir: `/same-root-output-1-${iteration}`,
        checkpointSaveDir: checkpointRoot,
        checkpointKind: 'checkpoint',
        checkpointStep: 1
      })
      await eventually(() => binding.activeJobs(handle) === 0)
      await binding.finetune(handle, {
        trainDatasetDir: `/same-root-train-${iteration}.jsonl`,
        outputParametersDir: `/same-root-output-2-${iteration}`,
        checkpointSaveDir: checkpointRoot,
        checkpointKind: 'checkpoint',
        checkpointStep: 2
      })
      await eventually(() => binding.activeJobs(handle) === 0)
      await binding.destroyInstance(handle)
      for (const step of [1, 2]) {
        const directory = await opfsDirectory(
          root,
          `${checkpointRoot}/checkpoint_step_${step}`,
          false
        )
        t.ok(committedDirectory(directory), `checkpoint ${step} durable ${iteration + 1}`)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser checkpoint callback rejects unsafe paths without poisoning unload 20x', async (t) => {
  let callbacks
  binding._setEngineFactoryForTest((options) => {
    callbacks = options
    return checkpointRetryEngine(options)
  })
  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = binding.createInstance(
      {},
      { path: '', projectionPath: '', config: {} },
      () => {}
    )
    await binding.activate(handle)
    for (const unsafe of [
      `/callback-${iteration}/../escape`,
      `/callback-${iteration}/..\0suffix/escape`
    ]) {
      await t.exception.all(
        () => callbacks.qvacPersistPath(handle.native, unsafe),
        /Invalid OPFS path/,
        `unsafe callback rejected ${iteration + 1}`
      )
    }
    await binding.destroyInstance(handle)
    t.pass(`unload succeeds ${iteration + 1}`)
  }
})

test('failed pause-checkpoint deletion is retried before unload 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(checkpointRetryEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const checkpointRoot = `/cleanup-retry-${iteration}`
      const handle = binding.createInstance({}, { path: '', config: {} }, () => {})
      await binding.activate(handle)
      await binding.finetune(handle, {
        trainDatasetDir: `/cleanup-train-${iteration}.jsonl`,
        outputParametersDir: `/cleanup-output-${iteration}`,
        checkpointSaveDir: checkpointRoot,
        checkpointKind: 'pause_checkpoint'
      })
      await eventually(() => binding.activeJobs(handle) === 0)
      const directory = await opfsDirectory(root, checkpointRoot, false)
      directory.failRemove = fsError('QuotaExceededError')
      await t.exception.all(
        () => binding.cancel(handle, 0),
        /QuotaExceededError/,
        `cleanup failure surfaced ${iteration + 1}`
      )
      directory.failRemove = null
      const module = handle.engine.module
      const destroyCallsBefore = module.destroyCalls
      await binding.destroyInstance(handle)
      t.absent(
        directory.children.get('pause_checkpoint_step_1'),
        `unload retried pause deletion ${iteration + 1}`
      )
      t.is(module.destroyCalls, destroyCallsBefore + 1, `native destroyed once ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

function completedFinetuneEngine(options) {
  const module = {
    FS: memoryFs(),
    persistedPaths: [],
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_finetune') {
        const params = JSON.parse(args[2])
        module.FS.set(`${params.outputParametersDir}/adapter.gguf`, Uint8Array.of(7, 8, 9))
        module.FS.set(
          `${params.checkpointSaveDir}/pause_checkpoint_step_1/state.bin`,
          Uint8Array.of(1, 2, 3)
        )
        module.FS.set(
          `${params.checkpointSaveDir}/checkpoint_step_2/state.bin`,
          Uint8Array.of(4, 5, 6)
        )
        const periodic = `${params.checkpointSaveDir}/checkpoint_step_2`
        module.persistedPaths.push(periodic)
        return options.qvacPersistPath(args[0], periodic).then(() => {
          module.FS.unlink(`${params.checkpointSaveDir}/pause_checkpoint_step_1/state.bin`)
          module.FS.rmdir(`${params.checkpointSaveDir}/pause_checkpoint_step_1`)
          options.qvacEmit(
            args[0],
            args[1],
            'JobEnded',
            JSON.stringify({ op: 'finetune', status: 'COMPLETED' })
          )
          options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
          return 0
        })
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }
  return module
}

function checkpointRetryEngine(options) {
  let nextHandle = 1
  const module = {
    FS: memoryFs(),
    destroyCalls: 0,
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return nextHandle++
      if (name === 'qvac_web_destroy') {
        module.destroyCalls++
        return 0
      }
      if (name === 'qvac_web_finetune') {
        const params = JSON.parse(args[2])
        const checkpoint = `${params.checkpointSaveDir}/${params.checkpointKind}_step_${params.checkpointStep ?? 1}`
        module.FS.set(`${checkpoint}/state.bin`, Uint8Array.of(args[0]))
        module.FS.set(`${params.outputParametersDir}/adapter.gguf`, Uint8Array.of(args[0]))
        return options.qvacPersistPath(args[0], checkpoint).then(() => {
          options.qvacEmit(
            args[0],
            args[1],
            'JobEnded',
            JSON.stringify({ op: 'finetune', status: 'PAUSED' })
          )
          options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
          return 0
        })
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }
  return module
}

function persistenceOrderingEngine(options, cooperative = false) {
  const submitted = new Map()
  let nextHandle = 1
  const module = {
    FS: memoryFs(),
    runCalls: 0,
    finetuneCalls: 0,
    destroyCalls: 0,
    discardCalls: 0,
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return nextHandle++
      if (name === 'qvac_web_destroy') {
        module.destroyCalls++
        return 0
      }
      if (name === 'qvac_web_supports_cooperative') return cooperative ? 1 : 0
      if (name === 'qvac_web_validate' || name === 'qvac_web_validate_batch') return 0
      if (name === 'qvac_web_run') {
        const messages = JSON.parse(args[2])
        module.runCalls++
        for (const cacheKey of new Set(
          messages.map((message) => message.cacheKey).filter(Boolean)
        )) {
          module.FS.set(cacheKey, Uint8Array.of(module.runCalls))
        }
        options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
        return 0
      }
      if (name === 'qvac_web_submit') {
        submitted.set(args[0], { id: args[1], messages: JSON.parse(args[3]) })
        return 0
      }
      if (name === 'qvac_web_step') {
        const pending = submitted.get(args[0])
        if (!pending) return 0
        submitted.delete(args[0])
        module.runCalls++
        for (const cacheKey of new Set(
          pending.messages.map((message) => message.cacheKey).filter(Boolean)
        )) {
          module.FS.set(cacheKey, Uint8Array.of(module.runCalls))
        }
        options.qvacEmit(args[0], pending.id, 'JobEnded', '{}')
        return 0
      }
      if (name === 'qvac_web_active_slots') return submitted.has(args[0]) ? 1 : 0
      if (name === 'qvac_web_discard_cache' || name === 'qvac_web_cache_request') {
        if (name === 'qvac_web_discard_cache' || args[3] === 1) module.discardCalls++
        return 0
      }
      if (name === 'qvac_web_finetune') {
        const params = JSON.parse(args[2])
        module.finetuneCalls++
        module.FS.set(
          `${params.outputParametersDir}/adapter.gguf`,
          Uint8Array.of(module.finetuneCalls)
        )
        options.qvacEmit(
          args[0],
          args[1],
          'JobEnded',
          JSON.stringify({ op: 'finetune', status: 'COMPLETED' })
        )
        options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
        return 0
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }
  return module
}

function cacheLifecycleEngine(options) {
  const states = new Map()
  let nextHandle = 1
  const module = {
    FS: memoryFs(),
    baseHydrated: new Set(),
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') {
        const handle = nextHandle++
        states.set(handle, { current: null, writes: 0 })
        return handle
      }
      if (name === 'qvac_web_validate' || name === 'qvac_web_validate_batch') return 0
      if (name === 'qvac_web_run') {
        const state = states.get(args[0])
        const message = JSON.parse(args[2])[0]
        if (message.baseCacheKey && module.FS.exists(message.baseCacheKey)) {
          module.baseHydrated.add(message.baseCacheKey)
        }
        if (state.current?.cacheKey && !state.current.ephemeral) {
          state.writes++
          module.FS.set(state.current.cacheKey, Uint8Array.of(state.writes))
        }
        state.current = { cacheKey: message.cacheKey, ephemeral: message.ephemeral === true }
        options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
        return 0
      }
      if (name === 'qvac_web_save_cache') {
        const state = states.get(args[0])
        state.writes++
        module.FS.set(args[1], Uint8Array.of(state.writes))
        return 0
      }
      if (name === 'qvac_web_flush_caches') {
        const state = states.get(args[0])
        if (state.current?.cacheKey && !state.current.ephemeral) {
          state.writes++
          module.FS.set(state.current.cacheKey, Uint8Array.of(state.writes))
        }
        return 0
      }
      if (name === 'qvac_web_destroy') {
        states.delete(args[0])
        return 0
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }
  return module
}

function failedCacheJobEngine(options, cooperative, callbackFailure) {
  let result = '{}'
  return {
    FS: memoryFs(),
    saveCalls: 0,
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_validate') return 0
      if (name === 'qvac_web_run') {
        if (callbackFailure) {
          options.qvacEmit(args[0], args[1], 'Output', 'token')
          options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
          return 0
        }
        result = JSON.stringify({ code: 'INVALID_ARGUMENT', error: 'run failed' })
        options.qvacEmit(args[0], args[1], 'Error', result)
        return -1
      }
      if (name === 'qvac_web_submit' && cooperative) {
        result = JSON.stringify({ code: 'INVALID_ARGUMENT', error: 'submit failed' })
        return -1
      }
      if (name === 'qvac_web_save_cache') {
        this.saveCalls++
        return 0
      }
      if (name === 'qvac_web_destroy') return 0
      if (name === 'qvac_web_result') return result
      return 0
    }
  }
}

function idleCooperativeCacheEngine(options) {
  const cacheOperations = new Map()
  const inferenceJobs = new Map()
  let nextHandle = 1
  const module = {
    FS: memoryFs(),
    order: [],
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return nextHandle++
      if (name === 'qvac_web_cache_request') {
        cacheOperations.set(`${args[0]}:${args[1]}`, {
          path: args[2],
          discard: args[3] === 1,
          complete: false
        })
        return 0
      }
      if (name === 'qvac_web_submit') {
        inferenceJobs.set(args[0], args[1])
        return 0
      }
      if (name === 'qvac_web_step') {
        for (const operation of cacheOperations.values()) {
          if (operation.complete) continue
          operation.complete = true
          module.order.push(operation.discard ? 'discard' : 'save')
          if (operation.discard && module.FS.exists(operation.path)) {
            module.FS.unlink(operation.path)
          } else module.FS.set(operation.path, Uint8Array.of(5))
        }
        for (const [handle, id] of inferenceJobs) {
          module.order.push('run')
          options.qvacEmit(handle, id, 'JobEnded', '{}')
          inferenceJobs.delete(handle)
        }
        return 0
      }
      if (name === 'qvac_web_cache_poll') {
        const key = `${args[0]}:${args[1]}`
        const operation = cacheOperations.get(key)
        if (!operation?.complete) return 1
        cacheOperations.delete(key)
        return 0
      }
      if (name === 'qvac_web_active_slots') return inferenceJobs.has(args[0]) ? 1 : 0
      if (name === 'qvac_web_finetune') {
        const params = JSON.parse(args[2])
        module.order.push('finetune')
        module.FS.set(`${params.outputParametersDir}/adapter.gguf`, Uint8Array.of(9))
        options.qvacEmit(
          args[0],
          args[1],
          'JobEnded',
          JSON.stringify({ op: 'finetune', status: 'COMPLETED' })
        )
        options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
        return 0
      }
      if (name === 'qvac_web_destroy') {
        module.order.push('destroy')
        return 0
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }
  return module
}

test('failed browser jobs do not create durable cache ownership 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (const scenario of [
      { cooperative: false, callbackFailure: true },
      { cooperative: true, callbackFailure: false }
    ]) {
      for (let iteration = 0; iteration < 20; iteration++) {
        binding._setEngineFactoryForTest((options) =>
          failedCacheJobEngine(options, scenario.cooperative, scenario.callbackFailure)
        )
        const directoryPath = `/failed-cache-${scenario.cooperative}-${iteration}`
        const path = `${directoryPath}/state.bin`
        const events = []
        const handle = binding.createInstance(
          {},
          { path: '', config: { parallel: scenario.cooperative ? 2 : 1 } },
          (_owner, event) => {
            events.push(event)
            if (scenario.callbackFailure && event === 'Output') throw new Error('listener failed')
          }
        )
        await binding.activate(handle)
        const admission = binding.runJob(
          handle,
          [{ type: 'text', input: 'prompt', cacheKey: path, generationParams: {} }],
          false
        )
        if (scenario.cooperative) {
          await t.exception.all(
            () => admission,
            /submit failed/,
            `submit rejection ${iteration + 1}`
          )
        } else {
          await admission
          await eventually(() => binding.activeJobs(handle) === 0)
          t.alike(events, ['Output', 'Error'], `callback failure terminal ${iteration + 1}`)
        }
        t.absent(handle.cachePaths.has(path), `failed path not tracked ${iteration + 1}`)
        await binding.destroyInstance(handle)
        let directory = null
        try {
          directory = await opfsDirectory(root, directoryPath, false)
        } catch (error) {
          if (error.name !== 'NotFoundError') throw error
        }
        t.absent(directory?.children.get('state.bin'), `no durable cache ${iteration + 1}`)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('failed browser jobs preserve previously tracked durable caches 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      binding._setEngineFactoryForTest((options) => failedCacheJobEngine(options, false, true))
      const directoryPath = `/tracked-failed-cache-${iteration}`
      const path = `${directoryPath}/state.bin`
      const bytes = Uint8Array.of(8, iteration)
      await opfsWrite(root, path, bytes)
      const handle = binding.createInstance({}, { path: '', config: {} }, (_owner, event) => {
        if (event === 'Output') throw new Error('listener failed')
      })
      await binding.activate(handle)
      handle.engine.module.FS.set(path, bytes)
      handle.cachePaths.add(path)
      handle.hydratedPaths.add(path)
      await binding.runJob(
        handle,
        [{ type: 'text', input: 'prompt', cacheKey: path, generationParams: {} }],
        false
      )
      await eventually(() => binding.activeJobs(handle) === 0)
      t.ok(handle.cachePaths.has(path), `tracked path retained ${iteration + 1}`)
      await binding.destroyInstance(handle)
      const directory = await opfsDirectory(root, directoryPath, false)
      t.alike(
        directory.children.get('state.bin').bytes,
        bytes,
        `durable bytes retained ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('idle cooperative cache operations complete and preserve control order 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(idleCooperativeCacheEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const handle = binding.createInstance({}, { path: '', config: { parallel: 2 } }, () => {})
      await binding.activate(handle)
      const module = handle.engine.module
      const base = `/idle-cache-${iteration}`

      const save = binding.saveCache(handle, `${base}/saved.bin`)
      const finetune = binding.finetune(handle, {
        trainDatasetDir: `${base}/train.jsonl`,
        outputParametersDir: `${base}/output`,
        checkpointSaveDir: `${base}/checkpoints`
      })
      await t.exception.all(
        () =>
          binding.runJob(handle, [
            { type: 'text', input: 'must not overtake', generationParams: {} }
          ]),
        /already set or being processed/,
        `later run rejected ${iteration + 1}`
      )
      await save
      const finetuneId = await finetune
      t.ok(finetuneId, `finetune admitted ${iteration + 1}`)
      await eventually(() => binding.activeJobs(handle) === 0)
      t.alike(
        module.order.slice(0, 2),
        ['save', 'finetune'],
        `save before finetune ${iteration + 1}`
      )

      module.FS.set(`${base}/discard.bin`, Uint8Array.of(iteration))
      await opfsWrite(root, `${base}/discard.bin`, Uint8Array.of(iteration))
      await binding.discardCache(handle, `${base}/discard.bin`)
      t.ok(module.order.includes('discard'), `idle discard stepped ${iteration + 1}`)

      const secondSave = binding.saveCache(handle, `${base}/cancelled-after-save.bin`)
      const cancelled = binding.cancel(handle)
      const laterRun = binding.runJob(handle, [
        { type: 'text', input: 'started after cancel', generationParams: {} }
      ])
      await Promise.all([secondSave, cancelled, laterRun])
      await eventually(() => binding.activeJobs(handle) === 0)
      t.alike(module.order.slice(-2), ['save', 'run'], `cancel snapshot preserved ${iteration + 1}`)

      const finalSave = binding.saveCache(handle, `${base}/unload-after-save.bin`)
      const unloaded = binding.destroyInstance(handle)
      await Promise.all([finalSave, unloaded])
      t.alike(module.order.slice(-2), ['save', 'destroy'], `unload follows cache ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('immediate unload waits for deferred browser activation 20x', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const gate = deferred()
    const module = {
      FS: memoryFs(),
      destroyCalls: 0,
      ccall(name) {
        if (name === 'qvac_web_create') return 1
        if (name === 'qvac_web_destroy') this.destroyCalls++
        if (name === 'qvac_web_result') return '{}'
        return 0
      }
    }
    binding._setEngineFactoryForTest(async () => {
      await gate.promise
      return module
    })
    const handle = binding.createInstance({}, { path: '', config: {} }, () => {})
    const activated = binding.activate(handle)
    const destroyed = binding.destroyInstance(handle)
    gate.resolve()
    await activated
    await destroyed
    t.is(module.destroyCalls, 1, `native destroyed ${iteration + 1}`)
    t.is(handle.native, 0, `native handle cleared ${iteration + 1}`)
    t.is(handle.engine, null, `engine released ${iteration + 1}`)
    t.is(handle.mounts.length, 0, `mounts released ${iteration + 1}`)
  }
})

test('browser cache persistence separates writable, base, and ephemeral paths 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(cacheLifecycleEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const base = `/cache-contract-${iteration}`
      const basePath = `${base}/base.bin`
      const firstPath = `${base}/first.bin`
      const secondPath = `${base}/second.bin`
      const ephemeralPath = `${base}/ephemeral.bin`
      const explicitPath = `${base}/explicit.bin`
      await opfsWrite(root, basePath, Uint8Array.of(7))
      await opfsWrite(root, ephemeralPath, Uint8Array.of(8))
      await opfsWrite(root, explicitPath, Uint8Array.of(9))
      const directory = await opfsDirectory(root, base, false)
      const baseFile = directory.children.get('base.bin')
      const ephemeralFile = directory.children.get('ephemeral.bin')
      const explicitFile = directory.children.get('explicit.bin')
      baseFile.failWrite = fsError('QuotaExceededError')
      ephemeralFile.failWrite = fsError('QuotaExceededError')
      explicitFile.failWrite = fsError('QuotaExceededError')

      const normal = binding.createInstance({}, { path: '', config: {} }, () => {})
      await binding.activate(normal)
      await binding.runJob(
        normal,
        [
          {
            type: 'text',
            input: 'first',
            cacheKey: firstPath,
            baseCacheKey: basePath,
            generationParams: {}
          }
        ],
        false
      )
      await eventually(() => binding.activeJobs(normal) === 0)
      t.ok(normal.engine.module.baseHydrated.has(basePath), `base hydrated ${iteration + 1}`)
      t.is(baseFile.createWritableCount, 0, `base never persisted ${iteration + 1}`)
      await binding.runJob(
        normal,
        [{ type: 'text', input: 'second', cacheKey: secondPath, generationParams: {} }],
        false
      )
      await eventually(() => binding.activeJobs(normal) === 0)
      const firstFile = directory.children.get('first.bin')
      t.ok(firstFile?.bytes.byteLength > 0, `previous key persisted on switch ${iteration + 1}`)
      await binding.destroyInstance(normal)
      const secondFile = directory.children.get('second.bin')
      t.ok(secondFile?.bytes.byteLength > 0, `active key flushed before unload ${iteration + 1}`)
      t.is(baseFile.createWritableCount, 0, `base untouched on unload ${iteration + 1}`)

      const ephemeral = binding.createInstance({}, { path: '', config: {} }, () => {})
      await binding.activate(ephemeral)
      await binding.runJob(
        ephemeral,
        [
          {
            type: 'text',
            input: 'ephemeral',
            cacheKey: ephemeralPath,
            ephemeral: true,
            generationParams: {}
          }
        ],
        false
      )
      await eventually(() => binding.activeJobs(ephemeral) === 0)
      await binding.destroyInstance(ephemeral)
      t.is(ephemeralFile.createWritableCount, 0, `ephemeral never auto-persisted ${iteration + 1}`)

      const explicit = binding.createInstance({}, { path: '', config: {} }, () => {})
      await binding.activate(explicit)
      await binding.runJob(
        explicit,
        [
          {
            type: 'text',
            input: 'explicit',
            cacheKey: explicitPath,
            ephemeral: true,
            generationParams: {}
          }
        ],
        false
      )
      await eventually(() => binding.activeJobs(explicit) === 0)
      t.is(
        explicitFile.createWritableCount,
        0,
        `explicit path initially memory-only ${iteration + 1}`
      )
      explicitFile.failWrite = null
      await binding.saveCache(explicit, explicitPath)
      t.ok(explicitFile.createWritableCount > 0, `explicit save persists ${iteration + 1}`)
      await binding.destroyInstance(explicit)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

function destroyPersistenceEngine() {
  return {
    FS: memoryFs(),
    destroyCalls: 0,
    failSave: false,
    lastError: '{}',
    ccall(name) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_save_cache' && this.failSave) {
        this.failSave = false
        this.lastError = JSON.stringify({ code: 'UnableToSaveSessionFile', error: 'save failed' })
        return -1
      }
      if (name === 'qvac_web_destroy') this.destroyCalls++
      if (name === 'qvac_web_result') return this.lastError
      return 0
    }
  }
}

test('browser unload retries failed native cache materialization 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(destroyPersistenceEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `/native-flush-${iteration}/state.bin`
      const handle = binding.createInstance({}, { path: '', config: {} }, () => {})
      await binding.activate(handle)
      const module = handle.engine.module
      const destroyCallsBefore = module.destroyCalls
      module.FS.set(path, Uint8Array.of(6, iteration))
      module.failSave = true
      handle.cachePaths.add(path)

      await t.exception.all(
        () => binding.destroyInstance(handle),
        /save failed/,
        `native save failure surfaced ${iteration + 1}`
      )
      t.is(module.destroyCalls, destroyCallsBefore, `native retained ${iteration + 1}`)
      t.ok(handle.engine, `engine retained ${iteration + 1}`)

      await binding.destroyInstance(handle)
      t.is(module.destroyCalls, destroyCallsBefore + 1, `destroyed after retry ${iteration + 1}`)
      const directory = await opfsDirectory(root, `/native-flush-${iteration}`, false)
      t.alike(
        directory.children.get('state.bin').bytes,
        Uint8Array.of(6, iteration),
        `materialized cache persisted ${iteration + 1}`
      )
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('discard drops runtime cache state but preserves its durable file 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (const cooperative of [false, true]) {
      binding._setEngineFactoryForTest((options) => persistenceOrderingEngine(options, cooperative))
      for (let iteration = 0; iteration < 20; iteration++) {
        const directoryPath = `/discard-${cooperative ? 'cooperative' : 'legacy'}-${iteration}`
        const path = `${directoryPath}/state.bin`
        await opfsWrite(root, path, Uint8Array.of(1, iteration))
        const directory = await opfsDirectory(root, directoryPath, false)
        const handle = binding.createInstance(
          {},
          { path: '', config: { parallel: cooperative ? '2' : '1' } },
          () => {}
        )
        await binding.activate(handle)
        const module = handle.engine.module
        const discardCallsBefore = module.discardCalls
        module.FS.set(path, Uint8Array.of(2, iteration))
        handle.cachePaths.add(path.slice(1))
        handle.hydratedPaths.add(path)
        await binding.discardCache(handle, path)
        t.is(
          module.discardCalls,
          discardCallsBefore + 1,
          `native discarded ${cooperative} ${iteration + 1}`
        )
        t.is(handle.cachePaths.size, 0, `unload tracking cleared ${cooperative} ${iteration + 1}`)
        t.absent(
          handle.hydratedPaths.has(path),
          `hydration tracking cleared ${cooperative} ${iteration + 1}`
        )
        t.absent(module.FS.exists(path), `MEMFS removed ${cooperative} ${iteration + 1}`)
        t.alike(
          directory.children.get('state.bin').bytes,
          Uint8Array.of(1, iteration),
          `durable cache preserved ${iteration + 1}`
        )
        await binding.destroyInstance(handle)
        t.ok(directory.children.get('state.bin'), `unload leaves durable cache ${iteration + 1}`)

        const reloaded = binding.createInstance(
          {},
          { path: '', config: { parallel: cooperative ? '2' : '1' } },
          () => {}
        )
        await binding.activate(reloaded)
        await binding.runJob(
          reloaded,
          [
            {
              type: 'text',
              input: 'reload',
              baseCacheKey: path,
              generationParams: {}
            }
          ],
          false
        )
        await eventually(() => binding.activeJobs(reloaded) === 0)
        t.ok(
          reloaded.engine.module.FS.exists(path),
          `reload can hydrate durable cache ${cooperative} ${iteration + 1}`
        )
        await binding.destroyInstance(reloaded)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('discard rejects directory cache keys without removing their contents 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (const cooperative of [false, true]) {
      binding._setEngineFactoryForTest((options) => persistenceOrderingEngine(options, cooperative))
      for (let iteration = 0; iteration < 20; iteration++) {
        const path = `/discard-directory-${cooperative ? 'cooperative' : 'legacy'}-${iteration}`
        const sentinel = `${path}/sentinel.bin`
        await opfsWrite(root, sentinel, Uint8Array.of(1, iteration))
        const directory = await opfsDirectory(root, path, false)
        const handle = binding.createInstance(
          {},
          { path: '', config: { parallel: cooperative ? '2' : '1' } },
          () => {}
        )
        await binding.activate(handle)
        const module = handle.engine.module
        module.FS.set(sentinel, Uint8Array.of(2, iteration))
        handle.cachePaths.add(path)
        handle.hydratedPaths.add(path)

        await t.exception.all(
          () => binding.discardCache(handle, path),
          /Expected a file/,
          `directory rejected ${cooperative} ${iteration + 1}`
        )
        t.alike(
          directory.children.get('sentinel.bin').bytes,
          Uint8Array.of(1, iteration),
          `durable sentinel preserved ${cooperative} ${iteration + 1}`
        )
        t.alike(
          module.FS.bytes(sentinel),
          Uint8Array.of(2, iteration),
          `MEMFS sentinel preserved ${cooperative} ${iteration + 1}`
        )
        await binding.destroyInstance(handle)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('unload retries every cache path after the first persistence failure 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(persistenceOrderingEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const firstPath = `/retry-cache-${iteration}/first.bin`
      const secondPath = `/retry-cache-${iteration}/second.bin`
      await opfsWrite(root, firstPath, Uint8Array.of(0))
      await opfsWrite(root, secondPath, Uint8Array.of(0))
      const directory = await opfsDirectory(root, `/retry-cache-${iteration}`, false)
      const firstFile = directory.children.get('first.bin')
      const secondFile = directory.children.get('second.bin')
      firstFile.failWrite = fsError('QuotaExceededError')
      const events = []
      const handle = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        (_owner, event, _data, error) => events.push({ event, error })
      )
      await binding.activate(handle)
      const callsBefore = handle.engine.module.runCalls
      await binding.runJob(
        handle,
        [
          { type: 'text', input: 'first', cacheKey: firstPath, generationParams: {} },
          { type: 'text', input: 'second', cacheKey: secondPath, generationParams: {} }
        ],
        false
      )
      await eventually(() => binding.activeJobs(handle) === 0)
      t.is(events.at(-1).event, 'Error', `persistence error surfaced ${iteration + 1}`)
      t.alike(secondFile.bytes, Uint8Array.of(0), `later path initially pending ${iteration + 1}`)

      firstFile.failWrite = null
      await binding.destroyInstance(handle)
      const expected = Uint8Array.of(callsBefore + 1)
      t.alike(firstFile.bytes, expected, `first path retried ${iteration + 1}`)
      t.alike(secondFile.bytes, expected, `later path retried ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('unsafe cache paths never dispatch, mutate MEMFS, or poison unload 20x', async (t) => {
  binding._setEngineFactoryForTest(persistenceOrderingEngine)
  for (let iteration = 0; iteration < 20; iteration++) {
    const events = []
    const handle = binding.createInstance(
      {},
      { path: '', projectionPath: '', config: {} },
      (_owner, event, _data, error) => events.push({ event, error })
    )
    await binding.activate(handle)
    const module = handle.engine.module
    const callsBefore = module.runCalls
    module.FS.set('/sentinel.bin', Uint8Array.of(9, iteration))
    for (const unsafe of [
      `/unsafe-cache-${iteration}/../sentinel.bin`,
      `/unsafe-cache-${iteration}/..\0suffix/sentinel.bin`
    ]) {
      await t.exception.all(
        () =>
          binding.runJob(
            handle,
            [{ type: 'text', input: 'unsafe', cacheKey: unsafe, generationParams: {} }],
            false
          ),
        /Invalid OPFS path/,
        `unsafe cache rejected ${iteration + 1}`
      )
      t.is(binding.activeJobs(handle), 0, `unsafe cache not admitted ${iteration + 1}`)
      t.is(module.runCalls, callsBefore, `native call not dispatched ${iteration + 1}`)
      t.alike(
        module.FS.bytes('/sentinel.bin'),
        Uint8Array.of(9, iteration),
        `sentinel untouched ${iteration + 1}`
      )
    }
    t.is(events.length, 0, `no callback emitted ${iteration + 1}`)
    await binding.destroyInstance(handle)
    t.pass(`unload succeeds ${iteration + 1}`)
  }
})

test('unload retries finetune output persistence before destroying native state 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(persistenceOrderingEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const output = `/retry-finetune-${iteration}`
      const adapter = `${output}/adapter.gguf`
      await opfsWrite(root, adapter, Uint8Array.of(0))
      const directory = await opfsDirectory(root, output, false)
      const destination = directory.children.get('adapter.gguf')
      destination.failWrite = fsError('QuotaExceededError')
      const events = []
      const handle = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        (_owner, event, _data, error) => events.push({ event, error })
      )
      await binding.activate(handle)
      const module = handle.engine.module
      const destroyCallsBefore = module.destroyCalls
      const finetuneCallsBefore = module.finetuneCalls
      await binding.finetune(handle, {
        trainDatasetDir: `/retry-finetune-train-${iteration}.jsonl`,
        outputParametersDir: output,
        checkpointSaveDir: `/retry-finetune-checkpoints-${iteration}`
      })
      await eventually(() => binding.activeJobs(handle) === 0)
      t.is(events.at(-1).event, 'Error', `finetune persistence failed ${iteration + 1}`)

      destination.failWrite = null
      await binding.destroyInstance(handle)
      t.alike(
        destination.bytes,
        Uint8Array.of(finetuneCallsBefore + 1),
        `finetune output retried ${iteration + 1}`
      )
      t.is(module.destroyCalls, destroyCallsBefore + 1, `destroyed once ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser terminal persistence owns shared MEMFS across handles 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  try {
    for (const cooperative of [false, true]) {
      binding._setEngineFactoryForTest((options) => persistenceOrderingEngine(options, cooperative))
      for (let iteration = 0; iteration < 20; iteration++) {
        const cacheKey = `/ordered-${cooperative ? 'cooperative' : 'legacy'}-${iteration}/cache.bin`
        await opfsWrite(root, cacheKey, Uint8Array.of(0))
        const directory = await opfsDirectory(
          root,
          `/ordered-${cooperative ? 'cooperative' : 'legacy'}-${iteration}`,
          false
        )
        const destination = directory.children.get('cache.bin')
        const gate = deferred()
        destination.writeGate = gate.promise
        const config = { parallel: cooperative ? '2' : '1' }
        const first = binding.createInstance({}, { path: '', projectionPath: '', config }, () => {})
        const second = binding.createInstance(
          {},
          { path: '', projectionPath: '', config },
          () => {}
        )
        await binding.activate(first)
        await binding.activate(second)
        const module = first.engine.module
        const runCallsBefore = module.runCalls

        await binding.runJob(
          first,
          [{ type: 'text', input: '[]', cacheKey, generationParams: {} }],
          false
        )
        await eventually(() => destination.activeWritables === 1)
        let admitted = false
        const secondAdmission = binding
          .runJob(second, [{ type: 'text', input: '[]', cacheKey, generationParams: {} }], false)
          .then((value) => {
            admitted = true
            return value
          })
        await new Promise((resolve) => setTimeout(resolve, 0))
        t.is(
          module.runCalls,
          runCallsBefore + 1,
          `next native call blocked ${cooperative} ${iteration + 1}`
        )
        t.is(admitted, false, `next admission queued ${cooperative} ${iteration + 1}`)

        destination.writeGate = null
        gate.resolve()
        await secondAdmission
        await eventually(() => binding.activeJobs(first) === 0 && binding.activeJobs(second) === 0)
        t.is(
          module.runCalls,
          runCallsBefore + 2,
          `both native calls completed ${cooperative} ${iteration + 1}`
        )
        t.alike(
          destination.bytes,
          Uint8Array.of(runCallsBefore + 2),
          `final bytes are not mixed ${iteration + 1}`
        )
        await binding.destroyInstance(first)
        await binding.destroyInstance(second)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser finetune stays exclusive through final persistence 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(persistenceOrderingEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const output = `/ordered-finetune-${iteration}`
      const adapter = `${output}/adapter.gguf`
      await opfsWrite(root, adapter, Uint8Array.of(0))
      const directory = await opfsDirectory(root, output, false)
      const destination = directory.children.get('adapter.gguf')
      const gate = deferred()
      destination.writeGate = gate.promise
      const first = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        () => {}
      )
      const second = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        () => {}
      )
      await binding.activate(first)
      await binding.activate(second)
      const module = first.engine.module
      const finetuneCallsBefore = module.finetuneCalls
      const params = {
        trainDatasetDir: `/ordered-train-${iteration}.jsonl`,
        outputParametersDir: output,
        checkpointSaveDir: `/ordered-checkpoints-${iteration}`
      }
      const firstId = await binding.finetune(first, params)
      await eventually(() => destination.activeWritables === 1)
      await t.exception.all(
        () => binding.runJob(first, [{ type: 'text', input: '[]', generationParams: {} }]),
        /already set or being processed/,
        `run remains exclusive ${iteration + 1}`
      )
      t.is(await binding.finetune(first, params), false, `second finetune blocked ${iteration + 1}`)

      const secondId = await binding.finetune(second, params)
      await new Promise((resolve) => setTimeout(resolve, 0))
      t.is(
        module.finetuneCalls,
        finetuneCallsBefore + 1,
        `cross-handle native call blocked ${iteration + 1}`
      )
      destination.writeGate = null
      gate.resolve()
      await binding.cancelJob(first, firstId, 1)
      await binding.cancelJob(second, secondId, 1)
      t.is(
        module.finetuneCalls,
        finetuneCallsBefore + 2,
        `cross-handle finetune completed ${iteration + 1}`
      )

      const nextId = await binding.finetune(first, params)
      t.ok(Number.isInteger(nextId), `finetune admitted after persistence ${iteration + 1}`)
      await binding.cancelJob(first, nextId, 1)
      t.alike(
        destination.bytes,
        Uint8Array.of(finetuneCallsBefore + 3),
        `final adapter bytes ${iteration + 1}`
      )
      await binding.destroyInstance(first)
      await binding.destroyInstance(second)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser unload retries persistence before destroying native state 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(destroyPersistenceEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const path = `/unload-cache-${iteration}/state.bin`
      await opfsWrite(root, path, Uint8Array.of(1, iteration))
      const directory = await opfsDirectory(root, `unload-cache-${iteration}`, false)
      const destination = directory.children.get('state.bin')
      destination.failWrite = fsError('QuotaExceededError')

      const handle = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        () => {}
      )
      await binding.activate(handle)
      const module = handle.engine.module
      const destroyCallsBefore = module.destroyCalls
      module.FS.set(path, Uint8Array.of(2, iteration))
      handle.cachePaths.add(path)

      let failure = null
      try {
        await binding.destroyInstance(handle)
      } catch (error) {
        failure = error
      }
      t.is(failure && failure.name, 'QuotaExceededError', `failure surfaced ${iteration + 1}`)
      t.is(module.destroyCalls, destroyCallsBefore, `native retained before retry ${iteration + 1}`)
      t.is(handle.native, 1, `native id retained before retry ${iteration + 1}`)
      t.ok(handle.engine, `engine retained before retry ${iteration + 1}`)

      destination.failWrite = null
      await binding.destroyInstance(handle)
      t.is(
        module.destroyCalls,
        destroyCallsBefore + 1,
        `native destroyed exactly once ${iteration + 1}`
      )
      t.is(handle.native, 0, `native id cleared ${iteration + 1}`)
      t.is(handle.engine, null, `engine released ${iteration + 1}`)
      t.alike(destination.bytes, Uint8Array.of(2, iteration), `cache persisted ${iteration + 1}`)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser finetune admission, pause, cancel, and terminal ordering hold 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(finetuneEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const events = []
      const handle = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        (_owner, event, data, error, id) => events.push({ event, data, error, id })
      )
      await binding.activate(handle)
      const id = await binding.finetune(handle, {
        trainDatasetDir: `/train-${iteration}.jsonl`,
        outputParametersDir: `/output-${iteration}`,
        checkpointSaveDir: `/checkpoints-${iteration}`
      })
      await t.exception.all(
        () => binding.runJob(handle, [{ type: 'text', input: '[]', generationParams: {} }]),
        /already set or being processed/,
        `exclusive admission ${iteration + 1}`
      )

      const pause = iteration % 2 === 0
      await binding.cancelJob(handle, id, pause ? 1 : 0)
      t.is(binding.activeJobs(handle), 0, `active jobs cleared ${iteration + 1}`)
      t.is(events[0].event, 'FinetuneProgress', `progress precedes terminal ${iteration + 1}`)
      await opfsWrite(
        root,
        `/checkpoints-${iteration}/pause_checkpoint_step_1/state.bin`,
        Uint8Array.of(iteration)
      )
      if (pause) {
        t.alike(
          events.slice(1).map(({ event }) => event),
          ['JobEnded', 'JobEnded'],
          `pause terminal order ${iteration + 1}`
        )
        t.is(events[1].data.status, 'PAUSED', `pause status ${iteration + 1}`)
        await binding.destroyInstance(handle)
        const checkpoints = await opfsDirectory(root, `/checkpoints-${iteration}`, false)
        t.ok(
          checkpoints.children.get('pause_checkpoint_step_1'),
          `unload preserves pause checkpoint ${iteration + 1}`
        )
      } else {
        t.alike(
          events.slice(1).map(({ event }) => event),
          ['JobEnded', 'JobEnded'],
          `cancel terminal order ${iteration + 1}`
        )
        t.is(events[1].data.status, 'PAUSED', `cancel resolves paused ${iteration + 1}`)
        handle.engine.module.FS.set(
          `/checkpoints-${iteration}/pause_checkpoint_step_1/state.bin`,
          Uint8Array.of(iteration)
        )
        await binding.cancel(handle, 0)
        const checkpoints = await opfsDirectory(root, `/checkpoints-${iteration}`, false)
        t.absent(
          checkpoints.children.get('pause_checkpoint_step_1'),
          `explicit cancel removes pause checkpoint ${iteration + 1}`
        )
        t.is(
          handle.engine.module.FS.exists(
            `/checkpoints-${iteration}/pause_checkpoint_step_1/state.bin`
          ),
          false,
          `explicit cancel removes memory checkpoint ${iteration + 1}`
        )
        await binding.destroyInstance(handle)
      }
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})

test('browser finetune rejects a queued single-request admission 20x', async (t) => {
  binding._setEngineFactoryForTest(finetuneEngine)
  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = binding.createInstance(
      {},
      { path: '', projectionPath: '', config: {} },
      () => {}
    )
    await binding.activate(handle)
    const admission = binding.runJob(handle, [{ type: 'text', input: '[]', generationParams: {} }])
    t.is(
      await binding.finetune(handle, {
        trainDatasetDir: `/queued-train-${iteration}.txt`,
        outputParametersDir: `/queued-output-${iteration}`
      }),
      false,
      `queued admission blocks finetuning ${iteration + 1}`
    )
    const { id } = await admission
    await binding.cancelJob(handle, id)
    await binding.destroyInstance(handle)
  }
})

test('completed browser finetune removes stale pause checkpoints but keeps periodic ones 20x', async (t) => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const root = new DirectoryHandle()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: () => Promise.resolve(root) } }
  })
  binding._setEngineFactoryForTest(completedFinetuneEngine)
  try {
    for (let iteration = 0; iteration < 20; iteration++) {
      const checkpointSaveDir = `/completed-checkpoints-${iteration}`
      const handle = binding.createInstance(
        {},
        { path: '', projectionPath: '', config: {} },
        () => {}
      )
      await binding.activate(handle)
      const id = await binding.finetune(handle, {
        trainDatasetDir: `/completed-train-${iteration}.txt`,
        outputParametersDir: `/completed-output-${iteration}`,
        checkpointSaveDir
      })
      await binding.cancelJob(handle, id, 1)
      const checkpoints = await opfsDirectory(root, checkpointSaveDir, false)
      t.absent(
        checkpoints.children.get('pause_checkpoint_step_1'),
        `completed pause checkpoint removed ${iteration + 1}`
      )
      t.ok(
        checkpoints.children.get('checkpoint_step_2'),
        `completed periodic checkpoint kept ${iteration + 1}`
      )
      t.alike(
        handle.engine.module.persistedPaths.slice(-1),
        [`${checkpointSaveDir}/checkpoint_step_2`],
        `periodic callback persists exact step ${iteration + 1}`
      )
      t.ok(
        checkpoints.children.get('checkpoint_step_2').children.get(CHECKPOINT_COMPLETE_FILE),
        `periodic checkpoint marked complete ${iteration + 1}`
      )
      t.is(
        handle.engine.module.FS.exists(`${checkpointSaveDir}/pause_checkpoint_step_1`),
        false,
        `completed memory pause checkpoint absent ${iteration + 1}`
      )
      await binding.destroyInstance(handle)
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else delete globalThis.navigator
  }
})
