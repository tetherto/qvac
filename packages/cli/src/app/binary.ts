import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  access,
  chmod,
  constants,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { z } from 'zod'

export const DEFAULT_BASE_URL = 'https://static.tether.dev/qv.ac/latest/cli'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 5000
const STALL_MS = 30_000

const plainName = z
  .string()
  .regex(/^[A-Za-z0-9._+-]+$/)
  .refine((name) => name !== '.' && !name.includes('..'), 'must not be . or contain ..')

const binarySchema = z.object({
  file: plainName.refine((name) => name.endsWith('.gz'), 'must end in .gz'),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  size: z.number().int().nonnegative()
})

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: plainName,
  binaries: z.record(z.string(), z.unknown())
})

const stateSchema = z.object({ version: plainName, checkedAt: z.number() })

type Manifest = z.infer<typeof manifestSchema>
type State = z.infer<typeof stateSchema>

export interface AppBinaryOptions {
  baseUrl: string
  dir: string
  hostKey: string
  now: number
  stallMs?: number
}

export function resolveBaseUrl(raw: string = DEFAULT_BASE_URL): string {
  assertAllowedUrl(raw)
  return raw.replace(/\/$/, '')
}

export async function ensureAppBinary(opts: AppBinaryOptions): Promise<string> {
  const state = await readState(opts.dir)
  const cached = state && (await usableBinary(opts, state.version))
  if (!state || !cached) {
    const signal = AbortSignal.timeout(opts.stallMs ?? STALL_MS)
    return install(opts, await fetchManifest(opts.baseUrl, signal))
  }
  if (opts.now - state.checkedAt < CHECK_INTERVAL_MS) return cached

  try {
    await writeState(opts.dir, { version: state.version, checkedAt: opts.now })
    const manifest = await fetchManifest(opts.baseUrl, AbortSignal.timeout(CHECK_TIMEOUT_MS))
    if (manifest.version === state.version) return cached
    const updated = await install(opts, manifest)
    await pruneVersions(opts.dir, manifest.version)
    return updated
  } catch (error: unknown) {
    if (process.env['DEBUG']) console.error('QV.AC app CLI update check failed:', error)
    return cached
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} kB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function assertAllowedUrl(raw: string): void {
  const url = URL.parse(raw)
  const local = url?.hostname === 'localhost' || url?.hostname === '127.0.0.1'
  if (url?.protocol === 'https:' || (url?.protocol === 'http:' && local)) return
  throw new Error(`Refusing ${raw}: the QV.AC app CLI is only downloaded over https`)
}

async function get(url: string, signal?: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, signal ? { signal } : {})
  } catch (error: unknown) {
    throw new Error(`Could not fetch ${url}: ${error instanceof Error ? error.message : error}`)
  }
  assertAllowedUrl(response.url)
  if (!response.ok || !response.body) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`)
  }
  return response
}

async function fetchManifest(baseUrl: string, signal?: AbortSignal): Promise<Manifest> {
  const url = `${baseUrl}/manifest.json`
  const response = await get(url, signal)
  const parsed = manifestSchema.safeParse(await response.json().catch(() => undefined))
  if (parsed.success) return parsed.data
  throw invalidManifest(url, parsed.error.issues[0])
}

function invalidManifest(url: string, issue?: z.core.$ZodIssue, prefix: string[] = []): Error {
  const where = [...prefix, ...(issue?.path ?? [])].join('.') || 'manifest'
  return new Error(`Invalid QV.AC app CLI manifest at ${url}: ${where}: ${issue?.message}`)
}

async function install(opts: AppBinaryOptions, manifest: Manifest): Promise<string> {
  if (!Object.hasOwn(manifest.binaries, opts.hostKey)) {
    const hosts = Object.keys(manifest.binaries).join(', ') || 'none'
    throw new Error(
      `The QV.AC app CLI ${manifest.version} has no binary for ${opts.hostKey} (available: ${hosts})`
    )
  }
  const entry = binarySchema.safeParse(manifest.binaries[opts.hostKey])
  if (!entry.success) {
    throw invalidManifest(`${opts.baseUrl}/manifest.json`, entry.error.issues[0], [
      'binaries',
      opts.hostKey
    ])
  }
  const binary = entry.data

  const versionDir = join(opts.dir, 'versions', manifest.version)
  const target = join(versionDir, binaryName(opts.hostKey))
  const temp = `${target}.${process.pid}.download`
  const url = `${opts.baseUrl}/${binary.file}`
  const stallMs = opts.stallMs ?? STALL_MS
  await mkdir(versionDir, { recursive: true })
  await removeStaleDownloads(versionDir, opts.now - stallMs)
  console.error(`Downloading the QV.AC app CLI ${manifest.version} (${formatSize(binary.size)})...`)
  const stall = new AbortController()
  const timer = setTimeout(() => stall.abort(), stallMs)

  try {
    const response = await get(url, stall.signal)
    const hash = createHash('sha256')
    let size = 0
    await pipeline(
      response.body as AsyncIterable<Uint8Array>,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          timer.refresh()
          hash.update(chunk)
          size += chunk.length
          yield chunk
        }
      },
      createGunzip(),
      createWriteStream(temp, { mode: 0o600 }),
      { signal: stall.signal }
    ).catch((error: unknown) => {
      throw new Error(
        `Could not download ${url}: ${error instanceof Error ? error.message : error}`
      )
    })
    const actual = hash.digest('hex')
    const expected = binary.sha256.toLowerCase()
    if (actual !== expected || size !== binary.size) {
      throw new Error(
        `Checksum or size mismatch for ${url}: expected sha256 ${expected} (${binary.size} bytes), got ${actual} (${size} bytes)`
      )
    }
    await chmod(temp, 0o755)
    try {
      await rename(temp, target)
    } catch (error: unknown) {
      if (!(await usableBinary(opts, manifest.version))) throw error
      await rm(temp, { force: true })
    }
  } catch (error: unknown) {
    await rm(temp, { force: true })
    if (!stall.signal.aborted) throw error
    throw new Error(`Download of ${url} stalled: no data for ${stallMs} ms`)
  } finally {
    clearTimeout(timer)
  }

  await writeState(opts.dir, { version: manifest.version, checkedAt: opts.now })
  return target
}

async function removeStaleDownloads(dir: string, before: number): Promise<void> {
  const names = await readdir(dir)
  await Promise.all(
    names
      .filter((name) => name.endsWith('.download'))
      .map(async (name) => {
        const stats = await stat(join(dir, name)).catch(() => null)
        if (stats && stats.mtimeMs < before) await rm(join(dir, name), { force: true })
      })
  )
}

async function usableBinary(opts: AppBinaryOptions, version: string): Promise<string | null> {
  const file = join(opts.dir, 'versions', version, binaryName(opts.hostKey))
  try {
    await access(file, constants.X_OK)
    return file
  } catch {
    return null
  }
}

async function pruneVersions(dir: string, keep: string): Promise<void> {
  const versions = await readdir(join(dir, 'versions')).catch(() => [])
  await Promise.all(
    versions
      .filter((version) => version !== keep)
      .map(async (version) => {
        const versionDir = join(dir, 'versions', version)
        const pids = await readdir(join(versionDir, 'run')).catch(() => [])
        if (pids.some((pid) => isRunning(Number(pid)))) return
        await rm(versionDir, { recursive: true, force: true }).catch(() => {})
      })
  )
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

function binaryName(hostKey: string): string {
  return hostKey.startsWith('win32-') ? 'qvac.exe' : 'qvac'
}

async function readState(dir: string): Promise<State | null> {
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function writeState(dir: string, state: State): Promise<void> {
  const file = join(dir, 'state.json')
  const temp = `${file}.${process.pid}`
  await writeFile(temp, JSON.stringify(state))
  await rename(temp, file)
}
