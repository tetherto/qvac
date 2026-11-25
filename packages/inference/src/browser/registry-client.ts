import type { QVACRegistryClient } from '@qvac/registry-client'
import type { AbortSignal } from 'bare-abort-controller'
import { ModelLoadFailedError } from '@/errors/index'

export interface RegistryClientTimings {
  graceMs: number
  pollMs: number
  queryWaitMs: number
  statusWaitMs: number
  legacyWaitMs: number
}

export type RegistryWait = 'download' | 'query' | 'status'

export interface AcquireRegistryClientOptions {
  wait: RegistryWait
  signal?: AbortSignal | undefined
  cancelled?: (() => Error) | undefined
}

export interface RegistryClientLease extends AsyncDisposable {
  readonly client: QVACRegistryClient
}

export function setRegistryClientTimingsForTest(_next: Partial<RegistryClientTimings> = {}): void {}

export async function acquireRegistryClient(
  _options: AcquireRegistryClientOptions
): Promise<RegistryClientLease> {
  throw new ModelLoadFailedError(
    'The QVAC peer-to-peer registry is not available in a browser. Use an HTTPS-backed registry model, an HTTPS URL, or a browser file.'
  )
}

export async function closeRegistryClient(): Promise<void> {}

export function hasActiveRegistryClient(): boolean {
  return false
}
