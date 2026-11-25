import test from 'brittle'
import Buffer from 'bare-buffer'
import fs, { hydrate, mountFile } from '@/browser/fs'
import { resolveMediaContent } from '@/browser/media-content'

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
  async createWritable(options?: { keepExistingData?: boolean }) {
    let next: Uint8Array<ArrayBufferLike> = options?.keepExistingData
      ? this.bytes.slice()
      : new Uint8Array(0)
    let position = 0
    return {
      write: async (data: Uint8Array) => {
        next = concat(next, data, position)
        position += data.byteLength
      },
      seek: async (nextPosition: number) => {
        position = nextPosition
      },
      close: async () => {
        this.bytes = next
      }
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
let getDirectoryCalls = 0
let failNextGetDirectory = true
;(globalThis as { navigator?: unknown }).navigator = {
  storage: {
    getDirectory: async () => {
      getDirectoryCalls++
      if (failNextGetDirectory) {
        failNextGetDirectory = false
        throw new Error('temporary OPFS initialization failure')
      }
      return root
    }
  }
}

async function opfsText(...path: string[]): Promise<string> {
  let directory = root
  for (const part of path.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
  const handle = await directory.getFileHandle(path[path.length - 1]!)
  return decode(handle.bytes)
}

test('hydrate: retries after failure and shares one concurrent initialization', async (t) => {
  await t.exception(hydrate(), /temporary OPFS initialization failure/)
  await Promise.all(Array.from({ length: 20 }, () => hydrate()))
  t.is(getDirectoryCalls, 2, 'one failed attempt and one shared retry')
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
  full.createWritable = async () => ({
    write: async () => {
      throw new Error('QuotaExceededError')
    },
    seek: async () => {},
    close: async () => {}
  })
  const error = await new Promise<Error>((resolve) => {
    const stream = fs.createWriteStream('/.qvac/full.bin')
    stream.on('error', resolve)
    stream.write(encode('data'))
  })
  t.ok(/QuotaExceeded/.test(error.message))
})

test('a failed synchronous persistence is reported by the next asynchronous call', async (t) => {
  const qvacDir = await root.getDirectoryHandle('.qvac')
  const full = await qvacDir.getFileHandle('sync-full.bin', { create: true })
  full.createWritable = async () => {
    throw new Error('QuotaExceededError')
  }
  fs.writeFileSync('/.qvac/sync-full.bin', encode('data'))
  await t.exception(fs.promises.stat('/.qvac/sync-full.bin'), /QuotaExceededError/)
  t.is(fs.readFileSync('/.qvac/sync-full.bin', 'utf8'), 'data')
})

test('destroying a write stream closes and preserves its completed chunks', async (t) => {
  const path = '/.qvac/interrupted.part'
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(path)
    stream.on('error', reject)
    stream.on('close', resolve)
    stream.write(encode('partial'), (error?: Error | null) => {
      if (error) reject(error)
      else stream.destroy()
    })
  })
  t.is(await opfsText('.qvac', 'interrupted.part'), 'partial')
  t.is((await fs.promises.stat(path)).size, 7)
})

test('promise calls see files added to OPFS after the index was loaded', async (t) => {
  const qvacDir = await root.getDirectoryHandle('.qvac')
  const local = await qvacDir.getDirectoryHandle('local', { create: true })
  const picked = await local.getFileHandle('picked.gguf', { create: true })
  picked.bytes = encode('GGUF')
  t.is(fs.existsSync('/.qvac/local/picked.gguf'), false, 'not in the index yet')
  t.alike(await fs.promises.readdir('/.qvac/local'), ['picked.gguf'])
  t.is((await fs.promises.stat('/.qvac/local/picked.gguf')).size, 4)
  t.ok(fs.existsSync('/.qvac/local/picked.gguf'), 'indexed after the refresh')

  picked.bytes = encode('GGUF-updated')
  t.is((await fs.promises.stat('/.qvac/local/picked.gguf')).size, 12)
  local.children.delete('picked.gguf')
  await t.exception(fs.promises.stat('/.qvac/local/picked.gguf'), /ENOENT/)
})

test('force-rm deletes cache directories created by another worker after hydration', async (t) => {
  const qvacDir = await root.getDirectoryHandle('.qvac')
  for (let iteration = 0; iteration < 20; iteration++) {
    const name = `external-cache-${iteration}`
    const directory = await qvacDir.getDirectoryHandle(name, { create: true })
    const file = await directory.getFileHandle('model.gguf', { create: true })
    file.bytes = encode(`model-${iteration}`)
    t.absent(fs.existsSync(`/.qvac/${name}`), 'the local index is stale before deletion')

    await fs.promises.rm(`/.qvac/${name}`, { recursive: true, force: true })

    await t.exception(qvacDir.getDirectoryHandle(name), /NotFound|not found/)
  }
})

test('promise mutations discover parents and files created by another worker', async (t) => {
  const qvacDir = await root.getDirectoryHandle('.qvac')
  const directory = await qvacDir.getDirectoryHandle('external-mutations', { create: true })
  const source = await directory.getFileHandle('source.bin', { create: true })
  source.bytes = encode('external')

  await fs.promises.rename(
    '/.qvac/external-mutations/source.bin',
    '/.qvac/external-mutations/renamed.bin'
  )
  t.is(await fs.promises.readFile('/.qvac/external-mutations/renamed.bin', 'utf8'), 'external')

  await fs.promises.writeFile('/.qvac/external-mutations/new.bin', 'new')
  t.is(await opfsText('.qvac', 'external-mutations', 'new.bin'), 'new')
  await fs.promises.unlink('/.qvac/external-mutations/new.bin')
  await t.exception(opfsText('.qvac', 'external-mutations', 'new.bin'), /NotFound|not found/)
})

test('mkdir, streams, and readdir refresh directory state changed by another worker', async (t) => {
  const qvacDir = await root.getDirectoryHandle('.qvac')
  const external = await qvacDir.getDirectoryHandle('external-streams', { create: true })
  const original = await external.getFileHandle('existing.bin', { create: true })
  original.bytes = encode('old')

  await t.exception(fs.promises.mkdir('/.qvac/external-streams'), /EEXIST/)
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream('/.qvac/external-streams/new.bin')
    stream.on('error', reject)
    stream.on('finish', resolve)
    stream.end(encode('new'))
  })
  t.is(await opfsText('.qvac', 'external-streams', 'new.bin'), 'new')

  qvacDir.children.delete('external-streams')
  await t.exception(fs.promises.readdir('/.qvac/external-streams'), /ENOENT/)
})

test('mountFile: a File handed over by the page is read in place, never copied to OPFS', async (t) => {
  const path = '/.qvac/mounted/abc/picked-in-place.gguf'
  mountFile(path, new FakeFile('picked-in-place.gguf', encode('GGUF-in-place'), 7))
  t.ok(fs.existsSync(path))
  t.alike(await fs.promises.readdir('/.qvac/mounted'), ['abc'])
  t.ok(fs.existsSync(path), 'refreshing a virtual parent keeps its mounted descendants')
  t.alike(await fs.promises.readdir('/.qvac/mounted/abc'), ['picked-in-place.gguf'])
  t.is((await fs.promises.stat(path)).size, 13)
  let text = ''
  for await (const chunk of fs.createReadStream(path, { start: 5 })) {
    text += decode(chunk as Uint8Array)
  }
  t.is(text, 'in-place')
  await fs.promises.copyFile(path, '/.qvac/copied-mounted.gguf')
  t.is(await fs.promises.readFile('/.qvac/copied-mounted.gguf', 'utf8'), 'GGUF-in-place')
  await fs.promises.unlink(path)
  t.absent(fs.existsSync(path), 'unlink removes a mounted file without requiring an OPFS copy')
  await t.exception(
    root.getDirectoryHandle('.qvac').then((d) => d.getDirectoryHandle('mounted')),
    /not found/
  )
})

test('mounted files can be overwritten and their virtual directories removed', async (t) => {
  const path = '/.qvac/virtual/model.gguf'
  mountFile(path, new FakeFile('model.gguf', encode('mounted'), 1))
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(path)
    stream.on('error', reject)
    stream.on('finish', resolve)
    stream.end(encode('persisted'))
  })
  t.is(await fs.promises.readFile(path, 'utf8'), 'persisted')

  mountFile('/.qvac/virtual/second.gguf', new FakeFile('second.gguf', encode('second'), 1))
  await fs.promises.rm('/.qvac/virtual', { recursive: true })
  t.absent(fs.existsSync('/.qvac/virtual'))
})

test('mounted files reject an invalid stream implementation at the read boundary', async (t) => {
  const invalid = {
    size: 1,
    lastModified: 1,
    arrayBuffer: async () => encode('x').buffer as ArrayBuffer,
    slice() {
      return this
    },
    stream: () => ({})
  }
  mountFile('/.qvac/invalid-stream.gguf', invalid)
  const stream = fs.createReadStream('/.qvac/invalid-stream.gguf')
  const failed = new Promise<Error>((resolve) => stream.on('error', resolve))
  stream.resume()
  const error = await failed
  t.ok(/must provide a readable stream/.test(error.message))
  await fs.promises.unlink('/.qvac/invalid-stream.gguf')
})

test('browser file lifecycle remains ordered across 20 iterations', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const directory = `/.qvac/stress-${iteration}`
    const partial = `${directory}/model.part`
    const final = `${directory}/model.gguf`
    await fs.promises.mkdir(directory)
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(partial)
      stream.on('error', reject)
      stream.on('finish', resolve)
      stream.write(encode(`part-${iteration}`))
      stream.end(encode('-done'))
    })
    await fs.promises.rename(partial, final)
    t.is(await fs.promises.readFile(final, 'utf8'), `part-${iteration}-done`)
    await fs.promises.rm(directory, { recursive: true })
    t.is(fs.existsSync(final), false)
  }
})

test('media paths reach the engine as bytes, from a mounted file or from OPFS', async (t) => {
  const mounted = '/.qvac/mounted/media/photo.jpg'
  mountFile(mounted, new FakeFile('photo.jpg', encode('picked-image'), 3))
  await fs.promises.writeFile('/.qvac/stored.png', encode('stored-image'))
  const bytes = new Uint8Array([1, 2, 3])
  const prompt: Array<{ role: string; type?: string; content: unknown }> = [
    { role: 'system', content: 'Describe images.' },
    { role: 'user', type: 'media', content: '/.qvac/stored.png' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'A: ' },
        { type: 'media', content: mounted },
        { type: 'media', content: bytes }
      ]
    }
  ]
  const resolved = await resolveMediaContent(prompt)
  t.alike(resolved[0], prompt[0], 'text messages pass through')
  t.is(decode(resolved[1]!.content as Uint8Array), 'stored-image', 'an attachment message is read')
  const parts = resolved[2]!.content as Array<{ type: string; content?: unknown; text?: string }>
  t.alike(parts[0], { type: 'text', text: 'A: ' })
  t.is(decode(parts[1]!.content as Uint8Array), 'picked-image', 'a mounted part is read in place')
  t.is(parts[2]!.content, bytes, 'bytes the caller passed are kept')
  t.is(prompt[1]!.content, '/.qvac/stored.png', "the caller's prompt is not mutated")
  await t.exception(
    resolveMediaContent([{ role: 'user', type: 'media', content: '/.qvac/missing.jpg' }]),
    /not found|ENOENT/
  )
  await fs.promises.unlink(mounted)
  await fs.promises.unlink('/.qvac/stored.png')
})

test('media resolution keeps each prompt in order across 20 concurrent calls', async (t) => {
  const paths = Array.from({ length: 20 }, (_, index) => `/.qvac/mounted/stress/${index}.jpg`)
  paths.forEach((path, index) =>
    mountFile(path, new FakeFile(`${index}.jpg`, encode(`image-${index}`), 1))
  )
  const resolved = await Promise.all(
    paths.map((path) =>
      resolveMediaContent<Array<{ type: string; content: unknown }>>([
        { type: 'media', content: path }
      ])
    )
  )
  resolved.forEach((prompt, index) =>
    t.is(decode(prompt[0]!.content as Uint8Array), `image-${index}`)
  )
  for (const path of paths) await fs.promises.unlink(path)
})

test('the browser build swaps in the media reader; native passes media paths as is', async (t) => {
  const { readFile } = await import('bare-fs/promises')
  const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
  t.is(
    pkg.browser['./dist/plugins/builtin/llamacpp-completion/ops/media-content.js'],
    './dist/browser/media-content.js'
  )
  const native = await import('@/plugins/builtin/llamacpp-completion/ops/media-content')
  const prompt = [{ role: 'user', type: 'media', content: '/photos/cat.jpg' }]
  t.is(await native.resolveMediaContent(prompt), prompt)
})
