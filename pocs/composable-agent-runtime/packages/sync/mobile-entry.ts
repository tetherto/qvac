import b4a from 'b4a'
import path from 'path'
import { SyncCore } from './lib/core.ts'
import { createIpcDuplex, type WorkletIPC } from './lib/mobile-ipc-duplex.ts'
import { parseSyncWorkletArgv } from './lib/react-native-argv.ts'

const PAIRED_MARKER = '.paired'

interface SyncCoreLike {
  readonly writable: boolean
  ready(): Promise<void>
  connect(stream: ReturnType<typeof createIpcDuplex>): void
  close(): Promise<void>
}

interface CreateSyncMobileEntryOptions {
  readonly readArgv?: () => readonly string[] | Promise<readonly string[]>
  readonly createCore?: (options: {
    readonly storagePath: string
    readonly pairingInvite?: Buffer
  }) => SyncCoreLike
  readonly createStream?: (ipc: WorkletIPC) => ReturnType<typeof createIpcDuplex>
  readonly markerExists?: (path: string) => Promise<boolean>
  readonly ensureStorage?: (path: string) => Promise<void>
  readonly writeMarker?: (path: string) => Promise<void>
}

export function createSyncMobileEntry({
  readArgv = defaultReadArgv,
  createCore = (options) => new SyncCore(options),
  createStream = (ipc) => createIpcDuplex(ipc),
  markerExists = markerExistsDefault,
  ensureStorage = defaultEnsureStorage,
  writeMarker = defaultWriteMarker
}: CreateSyncMobileEntryOptions = {}) {
  return async function start(ipc: WorkletIPC, ready?: () => void) {
    const processArgv = await readArgv()
    const options = parseSyncWorkletArgv(processArgv)
    const marker = path.join(options.storagePath, PAIRED_MARKER)
    if (!options.invite && !(await markerExists(marker))) {
      throw new Error('A pairing URI is required before mobile Sync can reconnect')
    }

    const core = createCore({
      storagePath: options.storagePath,
      ...(options.invite ? { pairingInvite: decodeInvite(options.invite) } : {})
    })
    await core.ready()
    if (!core.writable) {
      await core.close()
      throw new Error('Mobile Sync writer admission did not complete')
    }

    await ensureStorage(options.storagePath)
    await writeMarker(marker)
    const stream = createStream(ipc)
    core.connect(stream)
    stream.once('close', () => void core.close())
    ready?.()
    let closed = false
    return async function stop() {
      if (closed) return
      closed = true
      await core.close()
    }
  }
}

export default createSyncMobileEntry()

function decodeInvite(invite: string) {
  const base64 = invite.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  return b4a.from(`${base64}${padding}`, 'base64')
}

async function markerExistsDefault(marker: string) {
  const { stat } = await import('bare-fs/promises')
  try {
    return (await stat(marker)).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function defaultEnsureStorage(storagePath: string) {
  const { mkdir } = await import('bare-fs/promises')
  await mkdir(storagePath, { recursive: true })
}

async function defaultWriteMarker(markerPath: string) {
  const { writeFile } = await import('bare-fs/promises')
  await writeFile(markerPath, 'paired\n')
}

async function defaultReadArgv() {
  if (typeof Reflect.get(globalThis, 'Bare') !== 'undefined') {
    const module = await import('bare-process')
    return module.default.argv
  }
  const runtimeProcess = Reflect.get(globalThis, 'process') as
    | { readonly argv?: unknown }
    | undefined
  if (!Array.isArray(runtimeProcess?.argv)) return []
  return runtimeProcess.argv.filter((value): value is string => typeof value === 'string')
}

function isMissing(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
