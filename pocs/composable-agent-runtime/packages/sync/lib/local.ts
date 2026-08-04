import CorestoreStorage from 'hypercore-storage'
import HyperDB from 'hyperdb'
import crypto from 'hypercore-crypto'
import LocalDatabase from '../spec/local/hyperdb/index.js'
import type {
  LocalDevice,
  LocalMeshSession
} from '../spec/local/hyperschema/types.d.ts'

const SESSION = '@local/mesh-session'
const DEVICE = '@local/device'
const SINGLETON = 'default'

export interface MeshSession {
  readonly seed: Buffer
  readonly key: Buffer | null
  readonly writerSeed: Buffer
  readonly creator: boolean
}

export async function openLocalStore(storagePath: string) {
  const storage = new CorestoreStorage(storagePath)
  try {
    const database = HyperDB.rocks(storage.rocks.columnFamily('sync/local'), LocalDatabase)
    return new LocalStore(storage, database)
  } catch (error) {
    await Promise.allSettled([storage.close()])
    throw error
  }
}

export class LocalStore {
  private readonly storage: CorestoreStorage
  private readonly database: HyperDB

  constructor(storage: CorestoreStorage, database: HyperDB) {
    this.storage = storage
    this.database = database
  }

  async ensureDevice(id: Buffer) {
    const existing = await this.database.get<LocalDevice>(DEVICE, { id })
    if (existing) return existing
    return this.renameDevice(id, 'This device')
  }

  async renameDevice(id: Buffer, name: string) {
    const transaction = this.database.transaction()
    const device = { id, name }
    await transaction.insert<LocalDevice>(DEVICE, device)
    await transaction.flush()
    return device
  }

  async resolveSession(
    options: { seed?: Buffer; key?: Buffer; writerSeed?: Buffer } = {}
  ): Promise<MeshSession> {
    const existing = await this.database.get<LocalMeshSession>(SESSION, { id: SINGLETON })
    if (options.seed) {
      const session = {
        seed: options.seed,
        key: options.key ?? null,
        writerSeed: options.writerSeed ?? crypto.randomBytes(32),
        creator: options.key === undefined
      }
      await this.saveSession(session)
      return session
    }
    if (existing) {
      const session = {
        seed: existing.seed,
        key: existing.key ?? null,
        writerSeed: existing.writerSeed ?? crypto.randomBytes(32),
        creator: existing.creator ?? false
      }
      if (!existing.writerSeed) await this.saveSession(session)
      return session
    }
    const session = {
      seed: crypto.randomBytes(32),
      key: null,
      writerSeed: crypto.randomBytes(32),
      creator: true
    }
    await this.saveSession(session)
    return session
  }

  createCandidateSession(options: {
    seed: Buffer
    key?: Buffer
    writerSeed: Buffer
  }): MeshSession {
    return {
      seed: options.seed,
      key: options.key ?? null,
      writerSeed: options.writerSeed,
      creator: options.key === undefined
    }
  }

  async commitSession(session: MeshSession, key: Buffer) {
    await this.saveSession({ ...session, key })
  }

  async recordMeshKey(key: Buffer) {
    const existing = await this.resolveSession()
    await this.saveSession({ ...existing, key })
  }

  watch(listener: () => void) {
    this.database.watch(listener)
  }

  unwatch(listener: () => void) {
    this.database.unwatch(listener)
  }

  async close() {
    await this.database.close()
    await this.storage.close()
  }

  // Every accepted local mutation flushes before the write API resolves.
  private async saveSession(session: MeshSession) {
    const transaction = this.database.transaction()
    await transaction.insert<LocalMeshSession>(SESSION, {
      id: SINGLETON,
      seed: session.seed,
      key: session.key,
      writerSeed: session.writerSeed,
      creator: session.creator
    })
    await transaction.flush()
  }
}
