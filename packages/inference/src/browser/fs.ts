import { Readable, Writable } from 'bare-stream'
import Buffer from 'bare-buffer'
import { getEngineLogger } from '@/logging/index'
import { browser, type FileHandle, type WebStreamReader } from './globals'
import {
  INLINE_LIMIT,
  FsError,
  Stats,
  children,
  concatBytes,
  decode,
  encodingOf,
  entries,
  listDirectory,
  lookup,
  makeDirectory,
  mountedFiles,
  normalize,
  opfsDirectory,
  opfsFile,
  opfsRemove,
  opfsWrite,
  parentOf,
  persist,
  persistInBackground,
  readableFile,
  removeTree,
  requireParentDirectory,
  segments,
  setFile,
  setPersistQueue,
  settlePersistence,
  toBytes
} from './fs-state'

export { hydrate, mountFile } from './fs-state'

const logger = getEngineLogger()

function getStreamReader(stream: unknown): WebStreamReader {
  if (
    !stream ||
    typeof stream !== 'object' ||
    !('getReader' in stream) ||
    typeof stream.getReader !== 'function'
  ) {
    throw new TypeError('Mounted browser files must provide a readable stream')
  }
  return (stream.getReader as () => WebStreamReader)()
}

function hasMountedFile(path: string): boolean {
  for (const mounted of mountedFiles.keys()) {
    if (mounted === path || mounted.startsWith(`${path}/`)) return true
  }
  return false
}

export function existsSync(path: string | URL): boolean {
  return entries.has(normalize(path))
}

export function statSync(path: string | URL): Stats {
  return new Stats(lookup(normalize(path), 'stat'))
}

export function accessSync(path: string | URL): void {
  lookup(normalize(path), 'access')
}

export function mkdirSync(path: string | URL, options?: { recursive?: boolean }): void {
  const created = makeDirectory(normalize(path), !!options?.recursive)
  const last = created[created.length - 1]
  if (last) persistInBackground(last, () => opfsDirectory(last, true).then(() => {}))
}

export function readdirSync(path: string | URL, options?: unknown): string[] | unknown[] {
  return listDirectory(normalize(path), options)
}

export function readFileSync(path: string | URL, options?: unknown): Buffer | string {
  const target = normalize(path)
  const entry = lookup(target, 'open')
  if (entry.kind !== 'file') throw new FsError('EISDIR', 'read', target)
  if (!entry.data) {
    throw new Error(
      `readFileSync of a file over ${INLINE_LIMIT} bytes is not supported in the browser: ${target}`
    )
  }
  return decode(entry.data, encodingOf(options))
}

export function writeFileSync(path: string | URL, data: unknown, options?: unknown): void {
  const target = normalize(path)
  const bytes = toBytes(data, encodingOf(options))
  mountedFiles.delete(target)
  setFile(target, bytes)
  persistInBackground(target, () => opfsWrite(target, bytes.slice()))
}

export function unlinkSync(path: string | URL): void {
  const target = normalize(path)
  const entry = lookup(target, 'unlink')
  if (entry.kind === 'directory') throw new FsError('EISDIR', 'unlink', target)
  entries.delete(target)
  if (mountedFiles.delete(target)) return
  persistInBackground(target, () => opfsRemove(target, false))
}

async function refreshDirectory(path: string): Promise<void> {
  await settlePersistence()
  let directory
  try {
    directory = await opfsDirectory(path, false)
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'NotFoundError') throw error
    if (!hasMountedFile(path)) {
      removeTree(path)
      return
    }
    for (const name of children(path)) {
      const child = path === '/' ? `/${name}` : `${path}/${name}`
      if (!hasMountedFile(child)) removeTree(child)
    }
    return
  }
  let ancestor = ''
  for (const part of segments(path)) {
    ancestor += `/${part}`
    if (!entries.has(ancestor)) entries.set(ancestor, { kind: 'directory', mtimeMs: Date.now() })
  }
  const seen = new Set<string>()
  for await (const [name, handle] of directory) {
    const child = path === '/' ? `/${name}` : `${path}/${name}`
    seen.add(child)
    if (mountedFiles.has(child)) continue
    try {
      if (handle.kind === 'directory') {
        entries.set(child, { kind: 'directory', mtimeMs: Date.now() })
      } else {
        const file = await handle.getFile()
        const data = file.size <= INLINE_LIMIT ? new Uint8Array(await file.arrayBuffer()) : null
        entries.set(child, { kind: 'file', size: file.size, mtimeMs: file.lastModified, data })
      }
    } catch (error) {
      logger.warn(`Skipping unreadable OPFS entry ${child}: ${String(error)}`)
    }
  }
  for (const name of children(path)) {
    const child = path === '/' ? `/${name}` : `${path}/${name}`
    if (!seen.has(child) && !hasMountedFile(child)) removeTree(child)
  }
}

async function stat(path: string | URL): Promise<Stats> {
  const target = normalize(path)
  await refreshDirectory(parentOf(target))
  return statSync(target)
}

async function access(path: string | URL): Promise<void> {
  const target = normalize(path)
  await refreshDirectory(parentOf(target))
  accessSync(target)
}

async function mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<void> {
  const target = normalize(path)
  await refreshDirectory(parentOf(target))
  const created = makeDirectory(target, !!options?.recursive)
  const last = created[created.length - 1]
  if (!last) return
  try {
    await persist(() => opfsDirectory(last, true).then(() => {}))
  } catch (error) {
    for (const entry of created.reverse()) entries.delete(entry)
    throw error
  }
}

async function readdir(path: string | URL, options?: unknown): Promise<string[] | unknown[]> {
  const target = normalize(path)
  await refreshDirectory(target)
  return listDirectory(target, options)
}

async function readFile(path: string | URL, options?: unknown): Promise<Buffer | string> {
  const target = normalize(path)
  await refreshDirectory(parentOf(target))
  const entry = lookup(target, 'open')
  if (entry.kind !== 'file') throw new FsError('EISDIR', 'read', target)
  if (entry.data) return decode(entry.data, encodingOf(options))
  const file = await readableFile(target)
  return decode(new Uint8Array(await file.arrayBuffer()), encodingOf(options))
}

async function writeFile(path: string | URL, data: unknown, options?: unknown): Promise<void> {
  const target = normalize(path)
  const bytes = toBytes(data, encodingOf(options))
  await refreshDirectory(parentOf(target))
  requireParentDirectory(target, 'open')
  await persist(() => opfsWrite(target, bytes.slice()))
  mountedFiles.delete(target)
  setFile(target, bytes)
}

async function unlink(path: string | URL): Promise<void> {
  const target = normalize(path)
  await refreshDirectory(parentOf(target))
  const entry = lookup(target, 'unlink')
  if (entry.kind === 'directory') throw new FsError('EISDIR', 'unlink', target)
  if (!mountedFiles.has(target)) await persist(() => opfsRemove(target, false))
  entries.delete(target)
  mountedFiles.delete(target)
}

async function rm(
  path: string | URL,
  options?: { recursive?: boolean; force?: boolean }
): Promise<void> {
  const target = normalize(path)
  await refreshDirectory(parentOf(target))
  const entry = entries.get(target)
  if (!entry) {
    if (options?.force) return
    throw new FsError('ENOENT', 'rm', target)
  }
  if (entry.kind === 'directory' && !options?.recursive) {
    await refreshDirectory(target)
    if (children(target).length > 0) throw new FsError('ENOTEMPTY', 'rm', target)
  }
  try {
    await persist(() => opfsRemove(target, true))
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'NotFoundError' || !hasMountedFile(target)) {
      throw error
    }
  }
  removeTree(target)
  for (const mounted of [...mountedFiles.keys()]) {
    if (mounted === target || mounted.startsWith(`${target}/`)) mountedFiles.delete(mounted)
  }
}

async function rmdir(path: string | URL): Promise<void> {
  const target = normalize(path)
  await refreshDirectory(parentOf(target))
  const entry = lookup(target, 'rmdir')
  if (entry.kind !== 'directory') throw new FsError('ENOTDIR', 'rmdir', target)
  await refreshDirectory(target)
  if (children(target).length > 0) throw new FsError('ENOTEMPTY', 'rmdir', target)
  await persist(() => opfsRemove(target, false))
  entries.delete(target)
}

async function rename(from: string | URL, to: string | URL): Promise<void> {
  const source = normalize(from)
  const target = normalize(to)
  await refreshDirectory(parentOf(source))
  if (parentOf(target) !== parentOf(source)) await refreshDirectory(parentOf(target))
  const entry = lookup(source, 'rename')
  if (entry.kind !== 'file') throw new Error('Renaming directories is not supported in the browser')
  if (mountedFiles.has(source)) throw new Error('Renaming a mounted browser file is not supported')
  requireParentDirectory(target, 'rename')
  await persist(async () => {
    const file = await (await opfsFile(source)).getFile()
    const writable = await (await opfsFile(target, true)).createWritable()
    await file.stream().pipeTo(writable)
    await opfsRemove(source, false)
  })
  entries.delete(source)
  mountedFiles.delete(target)
  entries.set(target, { ...entry, mtimeMs: Date.now() })
}

async function copyFile(from: string | URL, to: string | URL): Promise<void> {
  const source = normalize(from)
  const target = normalize(to)
  await refreshDirectory(parentOf(source))
  if (parentOf(target) !== parentOf(source)) await refreshDirectory(parentOf(target))
  const entry = lookup(source, 'copyfile')
  if (entry.kind !== 'file') throw new FsError('EISDIR', 'copyfile', source)
  requireParentDirectory(target, 'copyfile')
  await persist(async () => {
    const writable = await (await opfsFile(target, true)).createWritable()
    const mounted = mountedFiles.get(source)
    if (!mounted) {
      await (await (await opfsFile(source)).getFile()).stream().pipeTo(writable)
      return
    }
    try {
      for await (const chunk of readChunks(getStreamReader(mounted.stream()))) {
        await writable.write(chunk)
      }
      await writable.close()
    } catch (error) {
      await writable.abort?.(error).catch(() => {})
      throw error
    }
  })
  mountedFiles.delete(target)
  entries.set(target, { ...entry, mtimeMs: Date.now() })
}

async function mkdtemp(prefix: string): Promise<string> {
  const path = `${normalize(prefix)}${browser.crypto.randomUUID().slice(0, 6)}`
  await mkdir(path)
  return path
}

const descriptors = new Map<number, Awaited<ReturnType<typeof readableFile>>>()
let nextDescriptor = 3

async function open(path: string | URL): Promise<number> {
  const target = normalize(path)
  await refreshDirectory(parentOf(target))
  lookup(target, 'open')
  const file = await readableFile(target)
  const fd = nextDescriptor++
  descriptors.set(fd, file)
  return fd
}

async function read(
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number
): Promise<number> {
  const file = descriptors.get(fd)
  if (!file) throw new FsError('EBADF', 'read', String(fd))
  const bytes = new Uint8Array(await file.slice(position, position + length).arrayBuffer())
  buffer.set(bytes, offset)
  return bytes.byteLength
}

async function close(fd: number): Promise<void> {
  descriptors.delete(fd)
}

export const promises = {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
}

export function createWriteStream(path: string | URL, options?: { flags?: string }): Writable {
  const target = normalize(path)
  const append = options?.flags === 'a'
  let position = 0
  let writer: Awaited<ReturnType<FileHandle['createWritable']>> | null = null
  let closing: Promise<void> | null = null
  let complete!: () => void
  const completed = new Promise<void>((resolve) => {
    complete = resolve
  })
  const refreshed = refreshDirectory(parentOf(target))
  const opened = refreshed.then(async () => {
    requireParentDirectory(target, 'open')
    const file = await opfsFile(target, true)
    let inline: Uint8Array | null = new Uint8Array(0)
    if (append) {
      const existing = await file.getFile()
      position = existing.size
      inline = position <= INLINE_LIMIT ? new Uint8Array(await existing.arrayBuffer()) : null
    }
    writer = await file.createWritable({ keepExistingData: append })
    if (append) await writer.seek(position)
    mountedFiles.delete(target)
    entries.set(target, { kind: 'file', size: position, mtimeMs: Date.now(), data: inline })
    return inline
  })
  setPersistQueue(opened.then(() => completed).catch(() => {}))

  const release = async () => {
    if (closing) return closing
    closing = (async () => {
      try {
        if (writer) await writer.close()
      } finally {
        writer = null
        complete()
      }
    })()
    return closing
  }

  let inline: Uint8Array | null = null

  function whenOpen(step: () => Promise<void>, callback: (error?: Error | null) => void): void {
    opened.then(
      (initialInline) => {
        inline ??= initialInline
        step().then(() => callback(null), callback)
      },
      (error: Error) => callback(error)
    )
  }

  return new Writable({
    write(chunk: Uint8Array, _encoding: string, callback: (error?: Error | null) => void) {
      whenOpen(async () => {
        const bytes = toBytes(chunk)
        if (!writer) throw new Error(`${target} is closed`)
        await writer.write(bytes)
        position += bytes.byteLength
        inline = inline && position <= INLINE_LIMIT ? concatBytes(inline, bytes) : null
        entries.set(target, { kind: 'file', size: position, mtimeMs: Date.now(), data: inline })
      }, callback)
    },
    final(callback: (error?: Error | null) => void) {
      whenOpen(release, callback)
    },
    destroy(error: Error | null, callback: (error?: Error | null) => void) {
      opened
        .then(release, () => complete())
        .then(
          () => callback(error),
          (closeError: Error) => callback(error ?? closeError)
        )
    }
  } as never)
}

export function createReadStream(
  path: string | URL,
  options?: { start?: number; end?: number }
): Readable {
  const target = normalize(path)
  async function* chunks(): AsyncGenerator<Buffer> {
    await refreshDirectory(parentOf(target))
    lookup(target, 'open')
    const file = await readableFile(target)
    const start = options?.start ?? 0
    const end = options?.end === undefined ? file.size : options.end + 1
    yield* readChunks(getStreamReader(file.slice(start, end).stream()))
  }
  return Readable.from(chunks())
}

export async function* readChunks(reader: WebStreamReader): AsyncGenerator<Buffer> {
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) return
      yield Buffer.from(result.value.buffer, result.value.byteOffset, result.value.byteLength)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export default {
  accessSync,
  close,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  open,
  promises,
  read,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
}
