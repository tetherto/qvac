// Browser stand-in for the subset of bare-fs the engine uses, backed by the
// origin private file system (OPFS). Absolute paths map onto the OPFS root:
// `/a/b.gguf` is `a/b.gguf` under `navigator.storage.getDirectory()`, the same
// convention the @qvac/llm-llamacpp browser build reads model files with.
//
// OPFS directories are only reachable asynchronously, but the engine also
// calls the synchronous API (existsSync, mkdirSync, small readFileSync and
// writeFileSync). So a metadata index of the whole tree, plus the contents of
// small files, is kept in memory: `hydrate()` loads it once before the engine
// starts, synchronous calls read and update it, and their changes are
// persisted to OPFS in call order. Promise calls wait for their own change to
// land. Large file contents are only streamed, through sync access handles
// (Dedicated Worker only) for writes and Blob slices for reads.
//
// Only the engine's own directory (`/.qvac`, as HOME is `/`) is indexed up
// front, so other data the app keeps in OPFS is never read. One worker per
// origin is assumed to own the tree; another tab changing it is not seen until
// that worker reloads.

import { Readable, Writable } from 'bare-stream'
import Buffer from 'bare-buffer'
import { getEngineLogger } from '@/logging/index'
import {
  browser,
  type DirectoryHandle,
  type FileHandle,
  type SyncAccessHandle,
  type WebFile,
  type WebStreamReader
} from './globals'

type Entry =
  | { kind: 'file'; size: number; mtimeMs: number; data: Uint8Array | null }
  | { kind: 'directory'; mtimeMs: number }

// Contents up to this size are kept in memory so readFileSync works on them.
const INLINE_LIMIT = 1024 * 1024

const ENGINE_ROOT = '/.qvac'

const logger = getEngineLogger()

const entries = new Map<string, Entry>([['/', { kind: 'directory', mtimeMs: Date.now() }]])
let hydrated: Promise<void> | null = null
let persistQueue: Promise<void> = Promise.resolve()

class FsError extends Error {
  code: string
  path: string
  constructor(code: string, syscall: string, path: string) {
    super(`${code}: ${syscall} '${path}'`)
    this.code = code
    this.path = path
  }
}

function normalize(input: string | URL): string {
  const raw = typeof input === 'string' ? input : decodeURIComponent(input.pathname)
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function toBytes(data: unknown, encoding?: string): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, (encoding ?? 'utf8') as 'utf8')
  if (data instanceof Uint8Array) return data
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new TypeError('Unsupported data type')
}

function encodingOf(options: unknown): string | undefined {
  if (typeof options === 'string') return options
  if (options && typeof options === 'object' && 'encoding' in options) {
    return (options as { encoding?: string }).encoding ?? undefined
  }
  return undefined
}

function decode(bytes: Uint8Array, encoding: string | undefined): Buffer | string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return encoding ? buffer.toString(encoding as 'utf8') : buffer
}

// --- OPFS access -----------------------------------------------------------

async function opfsDirectory(path: string, create: boolean): Promise<DirectoryHandle> {
  let directory = await browser.navigator.storage.getDirectory()
  for (const part of segments(path)) {
    directory = await directory.getDirectoryHandle(part, { create })
  }
  return directory
}

async function opfsFile(path: string, create = false): Promise<FileHandle> {
  const directory = await opfsDirectory(parentOf(path), create)
  return directory.getFileHandle(nameOf(path), { create })
}

async function opfsWrite(path: string, bytes: Uint8Array): Promise<void> {
  const writable = await (await opfsFile(path, true)).createWritable()
  await writable.write(bytes)
  await writable.close()
}

async function opfsRemove(path: string, recursive: boolean): Promise<void> {
  const directory = await opfsDirectory(parentOf(path), false)
  await directory.removeEntry(nameOf(path), { recursive })
}

async function walk(directory: DirectoryHandle, path: string): Promise<void> {
  for await (const [name, handle] of directory) {
    const child = `${path}/${name}`
    try {
      if (handle.kind === 'directory') {
        entries.set(child, { kind: 'directory', mtimeMs: Date.now() })
        await walk(handle, child)
      } else {
        const file = await handle.getFile()
        const data = file.size <= INLINE_LIMIT ? new Uint8Array(await file.arrayBuffer()) : null
        entries.set(child, { kind: 'file', size: file.size, mtimeMs: file.lastModified, data })
      }
    } catch (error) {
      // e.g. a file another context holds open with a sync access handle.
      logger.warn(`Skipping unreadable OPFS entry ${child}: ${String(error)}`)
    }
  }
}

/** Loads the OPFS index of `/.qvac`. Must complete before any synchronous call. */
export function hydrate(): Promise<void> {
  if (!hydrated) {
    hydrated = opfsDirectory(ENGINE_ROOT, true).then((directory) => {
      entries.set(ENGINE_ROOT, { kind: 'directory', mtimeMs: Date.now() })
      return walk(directory, ENGINE_ROOT)
    })
  }
  return hydrated
}

/** Runs @p task after every earlier change has reached OPFS. */
function persist(task: () => Promise<void>): Promise<void> {
  const result = persistQueue.then(task)
  persistQueue = result.catch(() => {})
  return result
}

/**
 * Persists a synchronous call's change. The caller has already returned, so a
 * failure (quota, a locked file) can only be reported: the index keeps the
 * change for this session but OPFS does not have it.
 */
function persistInBackground(path: string, task: () => Promise<void>): void {
  persist(task).catch((error: unknown) => {
    logger.error(`Failed to persist ${path} to the origin private file system: ${String(error)}`)
  })
}

// --- index operations --------------------------------------------------------

function lookup(path: string, syscall: string): Entry {
  const entry = entries.get(path)
  if (!entry) throw new FsError('ENOENT', syscall, path)
  return entry
}

function children(path: string): string[] {
  const prefix = path === '/' ? '/' : `${path}/`
  const names: string[] = []
  for (const key of entries.keys()) {
    if (key !== path && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
      names.push(key.slice(prefix.length))
    }
  }
  return names.sort()
}

function makeDirectory(path: string, recursive: boolean): string[] {
  const created: string[] = []
  const existing = entries.get(path)
  if (existing) {
    if (recursive && existing.kind === 'directory') return created
    throw new FsError('EEXIST', 'mkdir', path)
  }
  const parent = entries.get(parentOf(path))
  if (!parent) {
    if (!recursive) throw new FsError('ENOENT', 'mkdir', path)
    created.push(...makeDirectory(parentOf(path), true))
  } else if (parent.kind !== 'directory') {
    throw new FsError('ENOTDIR', 'mkdir', path)
  }
  entries.set(path, { kind: 'directory', mtimeMs: Date.now() })
  created.push(path)
  return created
}

function requireParentDirectory(path: string, syscall: string): void {
  const parent = entries.get(parentOf(path))
  if (!parent) throw new FsError('ENOENT', syscall, path)
  if (parent.kind !== 'directory') throw new FsError('ENOTDIR', syscall, path)
}

function setFile(path: string, bytes: Uint8Array): void {
  requireParentDirectory(path, 'open')
  const data = bytes.byteLength <= INLINE_LIMIT ? bytes.slice() : null
  entries.set(path, { kind: 'file', size: bytes.byteLength, mtimeMs: Date.now(), data })
}

function removeTree(path: string): void {
  const prefix = `${path}/`
  for (const key of [...entries.keys()]) {
    if (key === path || key.startsWith(prefix)) entries.delete(key)
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}

class Stats {
  size: number
  mtimeMs: number
  mtime: Date
  private readonly directory: boolean
  constructor(entry: Entry) {
    this.size = entry.kind === 'file' ? entry.size : 0
    this.mtimeMs = entry.mtimeMs
    this.mtime = new Date(entry.mtimeMs)
    this.directory = entry.kind === 'directory'
  }
  isFile(): boolean {
    return !this.directory
  }
  isDirectory(): boolean {
    return this.directory
  }
  isSymbolicLink(): boolean {
    return false
  }
}

class Dirent {
  name: string
  private readonly directory: boolean
  constructor(name: string, entry: Entry) {
    this.name = name
    this.directory = entry.kind === 'directory'
  }
  isFile(): boolean {
    return !this.directory
  }
  isDirectory(): boolean {
    return this.directory
  }
}

function listDirectory(path: string, options: unknown): string[] | Dirent[] {
  const entry = lookup(path, 'scandir')
  if (entry.kind !== 'directory') throw new FsError('ENOTDIR', 'scandir', path)
  const names = children(path)
  const withFileTypes =
    !!options &&
    typeof options === 'object' &&
    (options as { withFileTypes?: boolean }).withFileTypes
  if (!withFileTypes) return names
  return names.map((name) => new Dirent(name, entries.get(`${path === '/' ? '' : path}/${name}`)!))
}

// --- synchronous API -----------------------------------------------------------

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

export function readdirSync(path: string | URL, options?: unknown): string[] | Dirent[] {
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
  setFile(target, bytes)
  const copy = bytes.slice()
  persistInBackground(target, () => opfsWrite(target, copy))
}

export function unlinkSync(path: string | URL): void {
  const target = normalize(path)
  const entry = lookup(target, 'unlink')
  if (entry.kind === 'directory') throw new FsError('EISDIR', 'unlink', target)
  entries.delete(target)
  persistInBackground(target, () => opfsRemove(target, false))
}

// --- promise API -------------------------------------------------------------------

async function stat(path: string | URL): Promise<Stats> {
  return statSync(path)
}

async function access(path: string | URL): Promise<void> {
  accessSync(path)
}

async function mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<void> {
  const created = makeDirectory(normalize(path), !!options?.recursive)
  const last = created[created.length - 1]
  if (last) await persist(() => opfsDirectory(last, true).then(() => {}))
}

async function readdir(path: string | URL, options?: unknown): Promise<string[] | Dirent[]> {
  return listDirectory(normalize(path), options)
}

async function readFile(path: string | URL, options?: unknown): Promise<Buffer | string> {
  const target = normalize(path)
  const entry = lookup(target, 'open')
  if (entry.kind !== 'file') throw new FsError('EISDIR', 'read', target)
  if (entry.data) return decode(entry.data, encodingOf(options))
  await persistQueue
  const file = await (await opfsFile(target)).getFile()
  return decode(new Uint8Array(await file.arrayBuffer()), encodingOf(options))
}

async function writeFile(path: string | URL, data: unknown, options?: unknown): Promise<void> {
  const target = normalize(path)
  const bytes = toBytes(data, encodingOf(options))
  setFile(target, bytes)
  const copy = bytes.slice()
  await persist(() => opfsWrite(target, copy))
}

async function unlink(path: string | URL): Promise<void> {
  const target = normalize(path)
  const entry = lookup(target, 'unlink')
  if (entry.kind === 'directory') throw new FsError('EISDIR', 'unlink', target)
  entries.delete(target)
  await persist(() => opfsRemove(target, false))
}

async function rm(
  path: string | URL,
  options?: { recursive?: boolean; force?: boolean }
): Promise<void> {
  const target = normalize(path)
  const entry = entries.get(target)
  if (!entry) {
    if (options?.force) return
    throw new FsError('ENOENT', 'rm', target)
  }
  if (entry.kind === 'directory' && !options?.recursive && children(target).length > 0) {
    throw new FsError('ENOTEMPTY', 'rm', target)
  }
  removeTree(target)
  await persist(() => opfsRemove(target, true))
}

async function rmdir(path: string | URL): Promise<void> {
  const target = normalize(path)
  const entry = lookup(target, 'rmdir')
  if (entry.kind !== 'directory') throw new FsError('ENOTDIR', 'rmdir', target)
  if (children(target).length > 0) throw new FsError('ENOTEMPTY', 'rmdir', target)
  entries.delete(target)
  await persist(() => opfsRemove(target, false))
}

async function rename(from: string | URL, to: string | URL): Promise<void> {
  const source = normalize(from)
  const target = normalize(to)
  const entry = lookup(source, 'rename')
  if (entry.kind !== 'file') throw new Error('Renaming directories is not supported in the browser')
  requireParentDirectory(target, 'rename')
  entries.delete(source)
  entries.set(target, entry)
  await persist(async () => {
    const handle = await opfsFile(source)
    await handle.move(await opfsDirectory(parentOf(target), false), nameOf(target))
  })
}

async function copyFile(from: string | URL, to: string | URL): Promise<void> {
  const source = normalize(from)
  const target = normalize(to)
  const entry = lookup(source, 'copyfile')
  if (entry.kind !== 'file') throw new FsError('EISDIR', 'copyfile', source)
  requireParentDirectory(target, 'copyfile')
  entries.set(target, { ...entry, mtimeMs: Date.now() })
  await persist(async () => {
    const file = await (await opfsFile(source)).getFile()
    const writable = await (await opfsFile(target, true)).createWritable()
    await file.stream().pipeTo(writable)
  })
}

async function mkdtemp(prefix: string): Promise<string> {
  const path = `${normalize(prefix)}${browser.crypto.randomUUID().slice(0, 6)}`
  await mkdir(path)
  return path
}

// Descriptor-based reads (GGUF header probing).
const descriptors = new Map<number, WebFile>()
let nextDescriptor = 3

async function open(path: string | URL): Promise<number> {
  const target = normalize(path)
  lookup(target, 'open')
  await persistQueue
  const file = await (await opfsFile(target)).getFile()
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

// --- streams ---------------------------------------------------------------------

export function createWriteStream(path: string | URL, options?: { flags?: string }): Writable {
  const target = normalize(path)
  const append = options?.flags === 'a'
  requireParentDirectory(target, 'open')
  const existing = entries.get(target)
  const startSize = append && existing?.kind === 'file' ? existing.size : 0
  entries.set(target, { kind: 'file', size: startSize, mtimeMs: Date.now(), data: null })

  let handle: SyncAccessHandle | null = null
  let position = startSize
  const syncHandle = (): SyncAccessHandle => {
    if (!handle) throw new Error(`${target} is closed`)
    return handle
  }
  const opened = persist(async () => {
    const opened = await (await opfsFile(target, true)).createSyncAccessHandle()
    if (append) position = opened.getSize()
    else opened.truncate(0)
    handle = opened
  })
  const release = () => {
    const current = handle
    if (!current) return
    handle = null
    current.flush()
    current.close()
  }

  // Contents of a file that stays within INLINE_LIMIT, for readFileSync.
  let inline: Uint8Array | null =
    append && existing?.kind === 'file' ? existing.data : new Uint8Array(0)

  // Runs @p step once the handle is open, reporting any failure (a full quota,
  // a closed handle) to the stream instead of leaving it waiting.
  const whenOpen = (step: () => void, callback: (error?: Error | null) => void) => {
    opened.then(
      () => {
        try {
          step()
          callback(null)
        } catch (error) {
          callback(error as Error)
        }
      },
      (error: Error) => callback(error)
    )
  }

  return new Writable({
    write(chunk: Uint8Array, _encoding: string, callback: (error?: Error | null) => void) {
      whenOpen(() => {
        const bytes = toBytes(chunk)
        position += syncHandle().write(bytes, { at: position })
        inline = inline && position <= INLINE_LIMIT ? concatBytes(inline, bytes) : null
        entries.set(target, { kind: 'file', size: position, mtimeMs: Date.now(), data: inline })
      }, callback)
    },
    final(callback: (error?: Error | null) => void) {
      whenOpen(release, callback)
    },
    destroy(error: Error | null, callback: (error?: Error | null) => void) {
      opened.then(release, () => {}).then(() => callback(error))
    }
  } as never)
}

export function createReadStream(
  path: string | URL,
  options?: { start?: number; end?: number }
): Readable {
  const target = normalize(path)
  async function* chunks(): AsyncGenerator<Buffer> {
    lookup(target, 'open')
    await persistQueue
    const file = await (await opfsFile(target)).getFile()
    const start = options?.start ?? 0
    const end = options?.end === undefined ? file.size : options.end + 1
    yield* readChunks(file.slice(start, end).stream().getReader())
  }
  return Readable.from(chunks())
}

/** Yields a web stream's chunks as Buffers, cancelling it if iteration stops early. */
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
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  promises,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  open,
  read,
  close
}
