import b4a from 'b4a'
import { mkdir, stat, writeFile } from 'bare-fs/promises'
import path from 'bare-path'
import { SyncCore } from '@qvac/sync/core'
import { createIpcDuplex, type WorkletIPC } from '../src/ipc-duplex.ts'

const PAIRED_MARKER = '.paired'

interface WorkletOptions {
  readonly storagePath: string
  readonly invite?: string
}

export default async function start(ipc: WorkletIPC, encodedOptions: string | undefined) {
  console.log('[mobile-sync] worklet started')
  try {
    const options = parseOptions(encodedOptions)
    const marker = path.join(options.storagePath, PAIRED_MARKER)
    if (!options.invite && !(await markerExists(marker))) {
      throw new Error('A pairing URI is required before mobile Sync can reconnect')
    }

    console.log('[mobile-sync] opening core')
    const core = new SyncCore({
      storagePath: options.storagePath,
      ...(options.invite ? { pairingInvite: decodeInvite(options.invite) } : {})
    })
    await core.ready()
    if (!core.writable) {
      await core.close()
      throw new Error('Mobile Sync writer admission did not complete')
    }

    console.log('[mobile-sync] writer admitted')
    await mkdir(options.storagePath, { recursive: true })
    await writeFile(marker, 'paired\n')
    const stream = createIpcDuplex(ipc)
    core.connect(stream)
    stream.once('close', () => void core.close())
    console.log('[mobile-sync] HRPC connected')
  } catch (error) {
    console.error(
      '[mobile-sync] startup failed',
      error instanceof Error ? error.stack ?? error.message : String(error)
    )
    throw error
  }
}

function parseOptions(encoded: string | undefined): WorkletOptions {
  if (!encoded) throw new Error('Mobile Sync Worklet options are required')
  const parsed: unknown = JSON.parse(encoded)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('storagePath' in parsed) ||
    typeof parsed.storagePath !== 'string' ||
    parsed.storagePath.length === 0
  ) {
    throw new Error('Mobile Sync Worklet storagePath is required')
  }
  if (
    'invite' in parsed &&
    parsed.invite !== undefined &&
    typeof parsed.invite !== 'string'
  ) {
    throw new Error('Mobile Sync Worklet invite must be a string')
  }
  const invite =
    'invite' in parsed && typeof parsed.invite === 'string'
      ? parsed.invite
      : undefined
  return {
    storagePath: parsed.storagePath,
    ...(invite ? { invite } : {})
  }
}

function decodeInvite(invite: string) {
  const base64 = invite.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  return b4a.from(`${base64}${padding}`, 'base64')
}

async function markerExists(marker: string) {
  try {
    return (await stat(marker)).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function isMissing(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
