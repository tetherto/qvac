import test from 'brittle'
import Buffer from 'bare-buffer'
import fs, { hydrate } from '@/browser/fs'

// -----------------------------------------------------------------------------
// The browser build's bare-fs stand-in over the origin private file system.
// OPFS is replaced by an in-memory fake with the same handle API, installed as
// `navigator.storage` before the first call. The module keeps one index per
// process, so the tests below share one tree and run in order.
// -----------------------------------------------------------------------------

class FakeBlob {
  protected readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }
  get size(): number {
    return this.bytes.byteLength
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer as ArrayBuffer
  }
  slice(start = 0, end = this.bytes.byteLength): FakeBlob {
    return new FakeBlob(this.bytes.slice(start, end))
  }
  stream() {
    // Two chunks, so readers see more than one.
    const half = Math.ceil(this.bytes.byteLength / 2)
    const chunks = [this.bytes.slice(0, half), this.bytes.slice(half)].filter((c) => c.byteLength)
    return {
      getReader: () => ({
        read: async () => {
          const value = chunks.shift()
          return value ? { done: false as const, value } : { done: true as const }
        },
        cancel: async () => {}
      }),
      pipeTo: async (writable: { write(d: Uint8Array): Promise<void>; close(): Promise<void> }) => {
        for (const chunk of chunks.splice(0)) await writable.write(chunk)
        await writable.close()
      }
    }
  }
}

class FakeFile extends FakeBlob {
  readonly name: string
  readonly lastModified: number
  constructor(name: string, bytes: Uint8Array, lastModified: number) {
    super(bytes)
    this.name = name
    this.lastModified = lastModified
  }
}

function concat(a: Uint8Array, b: Uint8Array, at: number): Uint8Array {
  const out = new Uint8Array(Math.max(a.byteLength, at + b.byteLength))
  out.set(a)
  out.set(b, at)
  return out
}

function notFound(name: string): Error {
  const error = new Error(`${name} not found`)
  error.name = 'NotFoundError'
  return error
}

class FakeFileHandle {
  readonly kind = 'file'
  bytes: Uint8Array = new Uint8Array(0)
  name: string
  parent: FakeDirectory
  constructor(name: string, parent: FakeDirectory) {
    this.name = name
    this.parent = parent
  }
  async getFile(): Promise<FakeFile> {
    return new FakeFile(this.name, this.bytes.slice(), 1)
  }
  async createWritable() {
    let next: Uint8Array = new Uint8Array(0)
    return {
      write: async (data: Uint8Array) => {
        next = concat(next, data, next.byteLength)
      },
      close: async () => {
        this.bytes = next
      }
    }
  }
  async createSyncAccessHandle() {
    return {
      write: (buffer: Uint8Array, { at }: { at: number }) => {
        this.bytes = concat(this.bytes, buffer, at)
        return buffer.byteLength
      },
      truncate: (size: number) => {
        this.bytes = this.bytes.slice(0, size)
      },
      getSize: () => this.bytes.byteLength,
      flush: () => {},
      close: () => {}
    }
  }
  async move(directory: FakeDirectory, name: string): Promise<void> {
    this.parent.children.delete(this.name)
    this.name = name
    this.parent = directory
    directory.children.set(name, this)
  }
}

class FakeDirectory {
  readonly kind = 'directory'
  readonly children = new Map<string, FakeDirectory | FakeFileHandle>()
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    let child = this.children.get(name)
    if (!child && options?.create) {
      child = new FakeDirectory()
      this.children.set(name, child)
    }
    if (!(child instanceof FakeDirectory)) throw notFound(name)
    return child
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    let child = this.children.get(name)
    if (!child && options?.create) {
      child = new FakeFileHandle(name, this)
      this.children.set(name, child)
    }
    if (!(child instanceof FakeFileHandle)) throw notFound(name)
    return child
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw notFound(name)
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<[string, FakeDirectory | FakeFileHandle]> {
    yield* [...this.children.entries()]
  }
}

const encode = (text: string): Uint8Array => Buffer.from(text)
const decode = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString()

const root = new FakeDirectory()
const qvac = await root.getDirectoryHandle('.qvac', { create: true })
const existing = await qvac.getFileHandle('config.json', { create: true })
existing.bytes = encode('{"cached":true}')
;(globalThis as { navigator?: unknown }).navigator = { storage: { getDirectory: async () => root } }

async function opfsText(...path: string[]): Promise<string> {
  let directory = root
  for (const part of path.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
  const handle = await directory.getFileHandle(path[path.length - 1]!)
  return decode(handle.bytes)
}

test('hydrate: indexes the existing tree for synchronous calls', async (t) => {
  await hydrate()
  t.ok(fs.existsSync('/.qvac/config.json'))
  t.is(fs.statSync('/.qvac/config.json').size, 15)
  t.ok(fs.statSync('/.qvac').isDirectory())
  t.is(fs.readFileSync('/.qvac/config.json', 'utf8'), '{"cached":true}')
  t.alike(fs.readdirSync('/.qvac'), ['config.json'])
})

test('missing paths fail with ENOENT', async (t) => {
  t.is(fs.existsSync('/nope'), false)
  t.exception(() => fs.statSync('/nope'), /ENOENT/)
  await t.exception(fs.promises.stat('/nope'), /ENOENT/)
  await t.exception(fs.promises.unlink('/nope'), /ENOENT/)
  t.exception(() => fs.writeFileSync('/missing-dir/file', 'x'), /ENOENT/)
})

test('synchronous writes are visible at once and reach OPFS in order', async (t) => {
  fs.mkdirSync('/.qvac/models/a/b', { recursive: true })
  fs.writeFileSync('/.qvac/models/a/b/lock.json', '{"pid":1}')
  t.is(fs.readFileSync('/.qvac/models/a/b/lock.json', 'utf8'), '{"pid":1}')
  // A promise call waits for every earlier change to reach OPFS.
  await fs.promises.writeFile('/.qvac/models/flush', '')
  t.is(await opfsText('.qvac', 'models', 'a', 'b', 'lock.json'), '{"pid":1}')
  fs.unlinkSync('/.qvac/models/a/b/lock.json')
  await fs.promises.rm('/.qvac/models/flush')
  await t.exception(opfsText('.qvac', 'models', 'a', 'b', 'lock.json'), /NotFound|not found/)
})

test('write stream: writes, then appends to resume a download', async (t) => {
  const path = '/.qvac/models/model.gguf'
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(path)
    stream.on('error', reject)
    stream.on('finish', () => resolve())
    stream.write(encode('abc'))
    stream.end()
  })
  t.is(fs.statSync(path).size, 3)

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(path, { flags: 'a' })
    stream.on('error', reject)
    stream.on('finish', () => resolve())
    stream.write(encode('def'))
    stream.end()
  })
  t.is(fs.statSync(path).size, 6)
  t.is(await opfsText('.qvac', 'models', 'model.gguf'), 'abcdef')
})

test('read stream: reads a whole file and an inclusive byte range', async (t) => {
  const read = async (options?: { start?: number; end?: number }) => {
    let text = ''
    for await (const chunk of fs.createReadStream('/.qvac/models/model.gguf', options)) {
      text += decode(chunk as Uint8Array)
    }
    return text
  }
  t.is(await read(), 'abcdef')
  t.is(await read({ start: 1, end: 3 }), 'bcd')
})

test('descriptors: open, read at a position, close', async (t) => {
  const fd = await fs.open('/.qvac/models/model.gguf')
  const buffer = new Uint8Array(4)
  t.is(await fs.read(fd, buffer, 0, 4, 2), 4)
  t.is(decode(buffer), 'cdef')
  await fs.close(fd)
  await t.exception(fs.read(fd, buffer, 0, 1, 0), /EBADF/)
})

test('rename and recursive rm update both the index and OPFS', async (t) => {
  await fs.promises.rename('/.qvac/models/model.gguf', '/.qvac/models/a/model.gguf')
  t.is(fs.existsSync('/.qvac/models/model.gguf'), false)
  t.is(await opfsText('.qvac', 'models', 'a', 'model.gguf'), 'abcdef')

  await t.exception(fs.promises.rm('/.qvac/models/a'), /ENOTEMPTY/)
  await fs.promises.rm('/.qvac/models/a', { recursive: true })
  t.is(fs.existsSync('/.qvac/models/a/model.gguf'), false)
  t.alike(fs.readdirSync('/.qvac/models'), [])
  await fs.promises.rm('/.qvac/models/a', { recursive: true, force: true })
})

test('write stream: a small file written by stream is readable synchronously', async (t) => {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream('/.qvac/small.json')
    stream.on('error', reject)
    stream.on('finish', () => resolve())
    stream.write(encode('{"a":'))
    stream.write(encode('1}'))
    stream.end()
  })
  t.is(fs.readFileSync('/.qvac/small.json', 'utf8'), '{"a":1}')
})

test('write stream: a failed write is reported as a stream error', async (t) => {
  const qvacDir = await root.getDirectoryHandle('.qvac')
  const full = await qvacDir.getFileHandle('full.bin', { create: true })
  full.createSyncAccessHandle = async () => ({
    write: () => {
      throw new Error('QuotaExceededError')
    },
    truncate: () => {},
    getSize: () => 0,
    flush: () => {},
    close: () => {}
  })
  const error = await new Promise<Error>((resolve) => {
    const stream = fs.createWriteStream('/.qvac/full.bin')
    stream.on('error', resolve)
    stream.write(encode('data'))
  })
  t.ok(/QuotaExceeded/.test(error.message))
})
