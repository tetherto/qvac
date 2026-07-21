import Sidecar from 'bare-sidecar'
import { wrap, type IPC } from 'bare-stow/host'
import type { SyncCoreOptions } from './core.ts'
import { SyncClient } from './client.ts'
import { RuntimeComponentStartError } from '@qvac/runtime-contracts'

export interface SpawnSyncOptions extends SyncCoreOptions {
  readonly entry: string
}

export interface SyncSidecarExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface SyncSidecarDiagnostics {
  readonly stdout: string
  readonly stderr: string
}

export class SpawnedSyncClient extends SyncClient {
  readonly exited: Promise<SyncSidecarExit>
  private readonly ipc: IPC
  private readonly child: Sidecar
  private readonly diagnosticsState: SyncSidecarDiagnostics
  private hasExited = false

  constructor(
    ipc: IPC,
    child: Sidecar,
    exited: Promise<SyncSidecarExit>,
    diagnostics: SyncSidecarDiagnostics
  ) {
    super(ipc)
    this.ipc = ipc
    this.child = child
    this.exited = exited
    this.diagnosticsState = diagnostics
    void exited.then(() => {
      this.hasExited = true
    })
  }

  get diagnostics(): SyncSidecarDiagnostics {
    return { ...this.diagnosticsState }
  }

  async forceTerminate() {
    this.child.destroy(new Error('forced Sync termination'))
    return this.exited
  }

  async _close() {
    if (!this.hasExited) {
      await Promise.race([
        this.ipc.terminate().catch(() => {}),
        this.exited.then(() => {})
      ])
    }
    try {
      await super._close()
    } catch {
      // The transport is already gone after an unexpected child exit.
    }
    await this.exited
  }
}

export async function spawnSync({
  entry,
  storagePath,
  bootstrap,
  meshSeed,
  meshKey,
  pairingInvite,
  logging
}: SpawnSyncOptions): Promise<SpawnedSyncClient> {
  if (!storagePath) throw new Error('spawnSync storagePath is required')

  const options = JSON.stringify({
    storagePath,
    bootstrap,
    meshSeed: meshSeed?.toString('hex'),
    meshKey: meshKey?.toString('hex'),
    pairingInvite: pairingInvite?.toString('hex'),
    logging
  })
  const child = new Sidecar(entry, [`--sync-options=${options}`])
  const diagnostics = captureDiagnostics(child)
  const exited = observeExit(child)
  const ipc = wrap(child)

  try {
    await Promise.race([ipc.ready, rejectEarlyExit(exited)])
    const client = new SpawnedSyncClient(ipc, child, exited, diagnostics)
    await client.ready()
    return client
  } catch (error) {
    child.destroy()
    await exited
    const cause = error instanceof Error ? error : new Error(String(error))
    throw startupError(cause, diagnostics)
  }
}

function captureDiagnostics(child: Sidecar): SyncSidecarDiagnostics {
  const diagnostics = { stdout: '', stderr: '' }
  child.stdout?.on('data', (data) => {
    diagnostics.stdout += String(data)
  })
  child.stderr?.on('data', (data) => {
    diagnostics.stderr += String(data)
  })
  return diagnostics
}

function observeExit(child: Sidecar): Promise<SyncSidecarExit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function rejectEarlyExit(
  exited: Promise<SyncSidecarExit>
): Promise<never> {
  const result = await exited
  throw new Error(`Sync sidecar exited before ready (${formatExit(result)})`)
}

function startupError(error: Error, diagnostics: SyncSidecarDiagnostics) {
  const result = new RuntimeComponentStartError('sync', error)
  Reflect.set(result, 'diagnostics', { ...diagnostics })
  return result
}

function formatExit({ code, signal }: SyncSidecarExit) {
  if (signal) return `signal ${signal}`
  return `code ${code ?? 'unknown'}`
}
