import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import fsx from 'fs-native-extensions'
import Corestore from 'corestore'
import { QVACRegistryClient } from '@qvac/registry-client'
import { initEnv } from '@/runtime/env'
import {
  closeRegistryClient,
  setRegistryClientTimingsForTest,
  type RegistryClientTimings
} from '@/runtime/registry-client'
import { getCacheDir } from '@/utils/cache/paths'
import { DEFAULT_REGISTRY_CORE_KEY } from '@/constants/index'

// Short enough to keep the suite fast, long enough that one poll is distinct
// from the next on a loaded CI machine.
export const TEST_TIMINGS: RegistryClientTimings = {
  graceMs: 400,
  pollMs: 25,
  queryWaitMs: 800,
  legacyWaitMs: 500
}

export function makeTempHome(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qvac-registry-${label}-`))
}

/**
 * Point the engine at `home` and make the registry client open only its store:
 * the real CORESTORE lock is taken, nothing touches the network. Returns the
 * teardown, which closes the client and restores everything.
 */
export function useRegistryHome(
  home: string,
  timings: Partial<RegistryClientTimings> = TEST_TIMINGS
): () => Promise<void> {
  const argv = Bare.argv.slice()
  Bare.argv.length = 0
  Bare.argv.push('', '', JSON.stringify({ HOME_DIR: home }))
  initEnv()
  setRegistryClientTimingsForTest({ ...TEST_TIMINGS, ...timings })

  const proto = QVACRegistryClient.prototype as unknown as Record<string, unknown>
  const originalOpen = proto['_open']
  proto['_open'] = async function (this: { corestore: { ready(): Promise<void> } }) {
    await this.corestore.ready()
  }

  return async () => {
    await closeRegistryClient()
    proto['_open'] = originalOpen
    setRegistryClientTimingsForTest()
    Bare.argv.length = 0
    Bare.argv.push(...argv)
    initEnv()
  }
}

export function registryStoreDir(): string {
  return getCacheDir(`registry-corestore/${DEFAULT_REGISTRY_CORE_KEY}`)
}

function markerFile(kind: 'lease' | 'waiting'): string {
  return path.join(getCacheDir('registry-corestore'), `${DEFAULT_REGISTRY_CORE_KEY}.${kind}`)
}

export interface Held {
  release(): Promise<void>
}

/** Hold a marker lock the way another process on this version would. */
export function holdMarker(kind: 'lease' | 'waiting', shared: boolean): Held {
  const fd = fs.openSync(markerFile(kind), 'a+')
  if (!fsx.tryLock(fd, { shared })) {
    fs.closeSync(fd)
    throw new Error(`${kind} marker is already held`)
  }
  return {
    release: async () => {
      fsx.unlock(fd)
      fs.closeSync(fd)
    }
  }
}

/**
 * Open the store the way an SDK before leases does: the CORESTORE lock and no
 * marker. With `asCurrent`, also hold the lease marker, as a holder on this
 * version does.
 */
export async function holdStore(opts: { asCurrent?: boolean } = {}): Promise<Held> {
  const store = new Corestore(registryStoreDir(), { wait: false } as never)
  await store.ready()
  const lease = opts.asCurrent ? holdMarker('lease', false) : null
  return {
    release: async () => {
      await store.close()
      await lease?.release()
    }
  }
}

/** Try once to open the store the way an older SDK does; `null` if it is held. */
export async function tryOpenStoreOnce(): Promise<Held | null> {
  const store = new Corestore(registryStoreDir(), { wait: false } as never)
  try {
    await store.ready()
  } catch (error) {
    if (error instanceof Error && error.message.includes('could not be locked')) return null
    throw error
  }
  return { release: () => store.close() }
}
