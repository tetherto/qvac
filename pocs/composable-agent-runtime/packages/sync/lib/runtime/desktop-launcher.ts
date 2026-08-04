import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import stow from 'bare-stow'
import type { SyncCoreOptions } from '../core.ts'
import { spawnSync, type SpawnedSyncClient } from '../spawn.ts'

export interface DesktopSyncWorker {
  readonly client: SpawnedSyncClient
  close(): Promise<void>
}

export async function launchDesktopSync(options: SyncCoreOptions): Promise<DesktopSyncWorker> {
  const directory = await mkdtemp(
    fileURLToPath(new URL('../../../../.stow-sync-', import.meta.url))
  )
  try {
    const entry = await buildSidecar(directory)
    const client = await spawnSync({ ...options, entry })
    let closed: Promise<void> | null = null
    return {
      client,
      close() {
        if (closed) return closed
        closed = (async () => {
          try {
            await client.close()
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        })()
        return closed
      }
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function buildSidecar(directory: string) {
  const output = new URL(`file://${join(directory, 'sync.js')}`)
  const entry = new URL('../../sidecar-entry.ts', import.meta.url).href
  const artifacts = stow(entry, 'bare-sidecar', output.href, {
    base: new URL('../../', import.meta.url).href,
    hosts: [`${os.platform()}-${os.arch()}`]
  })
  for await (const _artifact of artifacts);
  return join(directory, 'sync.bundle')
}
