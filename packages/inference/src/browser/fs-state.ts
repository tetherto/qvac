import Buffer from 'bare-buffer'
import { getEngineLogger } from '@/logging/index'
import { browser, type DirectoryHandle, type FileHandle, type WebFile } from './globals'

export type Entry =
  | { kind: 'file'; size: number; mtimeMs: number; data: Uint8Array | null }
  | { kind: 'directory'; mtimeMs: number }

export const INLINE_LIMIT = 1024 * 1024
const ENGINE_ROOT = '/.qvac'
const logger = getEngineLogger()

export const entries = new Map<string, Entry>([['/', { kind: 'directory', mtimeMs: Date.now() }]])
let hydrated: Promise<void> | null = null
export let persistQueue: Promise<void> = Promise.resolve()
let backgroundPersistError: Error | null = null

export class FsError extends Error {
  code: string
  path: string
  constructor(code: string, syscall: string, path: string) {
    super(`${code}: ${syscall} '${path}'`)
    this.code = code
    this.path = path
  }
}

export function normalize(input: string | URL): string {
  const raw = typeof input === 'string' ? input : decodeURIComponent(input.pathname)
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function toBytes(data: unknown, encoding?: string): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, (encoding ?? 'utf8') as 'utf8')
  if (data instanceof Uint8Array) return data
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new TypeError('Unsupported data type')
}

export function encodingOf(options: unknown): string | undefined {
  if (typeof options === 'string') return options
  if (options && typeof options === 'object' && 'encoding' in options) {
    return (options as { encoding?: string }).encoding ?? undefined
  }
  return undefined
}

export function decode(bytes: Uint8Array, encoding: string | undefined): Buffer | string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return encoding ? buffer.toString(encoding as 'utf8') : buffer
}

export async function opfsDirectory(path: string, create: boolean): Promise<DirectoryHandle> {
  let directory = await browser.navigator.storage.getDirectory()
  for (const part of segments(path)) {
    directory = await directory.getDirectoryHandle(part, { create })
  }
  return directory
}

export async function opfsFile(path: string, create = false): Promise<FileHandle> {
  const directory = await opfsDirectory(parentOf(path), create)
  return directory.getFileHandle(nameOf(path), { create })
}

export async function opfsWrite(path: string, bytes: Uint8Array): Promise<void> {
  const writable = await (await opfsFile(path, true)).createWritable()
  await writable.write(bytes)
  await writable.close()
}

export async function opfsRemove(path: string, recursive: boolean): Promise<void> {
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
      logger.warn(`Skipping unreadable OPFS entry ${child}: ${String(error)}`)
    }
  }
}

const MOUNTED_FILES_KEY = Symbol.for('qvac.browser.mountedFiles')
const globals = globalThis as unknown as Record<symbol, Map<string, BrowserFileInput> | undefined>
export const mountedFiles: Map<string, BrowserFileInput> = (globals[MOUNTED_FILES_KEY] ??=
  new Map())

export interface BrowserBlobInput {
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
  slice(start?: number, end?: number): BrowserBlobInput
  stream(): unknown
}

export interface BrowserFileInput extends BrowserBlobInput {
  readonly lastModified: number
}

export function mountFile(path: string, file: BrowserFileInput): void {
  const target = normalize(path)
  let directory = ''
  for (const part of segments(parentOf(target))) {
    directory += `/${part}`
    if (!entries.has(directory)) entries.set(directory, { kind: 'directory', mtimeMs: Date.now() })
  }
  entries.set(target, { kind: 'file', size: file.size, mtimeMs: file.lastModified, data: null })
  mountedFiles.set(target, file)
}

export async function readableFile(path: string): Promise<BrowserFileInput | WebFile> {
  const mounted = mountedFiles.get(path)
  if (mounted) return mounted
  await settlePersistence()
  return (await opfsFile(path)).getFile()
}

export function hydrate(): Promise<void> {
  if (!hydrated) {
    hydrated = opfsDirectory(ENGINE_ROOT, true)
      .then((directory) => {
        entries.set(ENGINE_ROOT, { kind: 'directory', mtimeMs: Date.now() })
        return walk(directory, ENGINE_ROOT)
      })
      .catch((error: unknown) => {
        hydrated = null
        throw error
      })
  }
  return hydrated
}

export function persist(task: () => Promise<void>, background = false): Promise<void> {
  const result = persistQueue.then(async () => {
    const error = takeBackgroundPersistError()
    if (error) throw error
    await task()
  })
  persistQueue = result.catch(() => {})
  if (background) {
    void result.catch((error: unknown) => {
      backgroundPersistError ??= error instanceof Error ? error : new Error(String(error))
    })
  }
  return result
}

export function setPersistQueue(queue: Promise<void>): void {
  persistQueue = queue
}

export function takeBackgroundPersistError(): Error | null {
  const error = backgroundPersistError
  backgroundPersistError = null
  return error
}

export async function settlePersistence(): Promise<void> {
  await persistQueue
  const error = takeBackgroundPersistError()
  if (error) throw error
}

export function persistInBackground(path: string, task: () => Promise<void>): void {
  persist(task, true).catch((error: unknown) => {
    logger.error(`Failed to persist ${path} to the origin private file system: ${String(error)}`)
  })
}

export function lookup(path: string, syscall: string): Entry {
  const entry = entries.get(path)
  if (!entry) throw new FsError('ENOENT', syscall, path)
  return entry
}

export function children(path: string): string[] {
  const prefix = path === '/' ? '/' : `${path}/`
  const names: string[] = []
  for (const key of entries.keys()) {
    if (key !== path && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
      names.push(key.slice(prefix.length))
    }
  }
  return names.sort()
}

export function makeDirectory(path: string, recursive: boolean): string[] {
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

export function requireParentDirectory(path: string, syscall: string): void {
  const parent = entries.get(parentOf(path))
  if (!parent) throw new FsError('ENOENT', syscall, path)
  if (parent.kind !== 'directory') throw new FsError('ENOTDIR', syscall, path)
}

export function setFile(path: string, bytes: Uint8Array): void {
  requireParentDirectory(path, 'open')
  const data = bytes.byteLength <= INLINE_LIMIT ? bytes.slice() : null
  entries.set(path, { kind: 'file', size: bytes.byteLength, mtimeMs: Date.now(), data })
}

export function removeTree(path: string): void {
  const prefix = `${path}/`
  for (const key of [...entries.keys()]) {
    if (key === path || key.startsWith(prefix)) entries.delete(key)
  }
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}

export class Stats {
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

export class Dirent {
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

export function listDirectory(path: string, options: unknown): string[] | Dirent[] {
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
