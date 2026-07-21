import CorestoreStorage from 'hypercore-storage'
import HyperDB from 'hyperdb'
import crypto from 'hypercore-crypto'
import LocalDatabase from '../spec/local/hyperdb/index.js'
import type {
  LocalMeshSession,
  LocalUserProfile
} from '../spec/local/hyperschema/types.d.ts'

const PROFILE = '@local/user-profile'
const SESSION = '@local/mesh-session'
const SINGLETON = 'default'

export interface MeshSession {
  readonly seed: Buffer
  readonly key: Buffer | null
  readonly creator: boolean
}

export async function openLocalStore(storagePath: string) {
  const storage = new CorestoreStorage(storagePath)
  const database = HyperDB.rocks(storage.rocks.columnFamily('sync/local'), LocalDatabase)
  return new LocalStore(storage, database)
}

export class LocalStore {
  private readonly storage: CorestoreStorage
  private readonly database: HyperDB

  constructor(storage: CorestoreStorage, database: HyperDB) {
    this.storage = storage
    this.database = database
  }

  async getUserProfile() {
    const row = await this.database.get<LocalUserProfile>(PROFILE, { id: SINGLETON })
    return row ? { name: row.name } : null
  }

  async setUserProfile(name: string) {
    const transaction = this.database.transaction()
    await transaction.insert<LocalUserProfile>(PROFILE, { id: SINGLETON, name })
    await transaction.flush()
    return { name }
  }

  async resolveSession(options: { seed?: Buffer; key?: Buffer } = {}): Promise<MeshSession> {
    const existing = await this.database.get<LocalMeshSession>(SESSION, { id: SINGLETON })
    if (options.seed) {
      const session = {
        seed: options.seed,
        key: options.key ?? null,
        creator: options.key === undefined
      }
      await this.saveSession(session)
      return session
    }
    if (existing) {
      return {
        seed: existing.seed,
        key: existing.key ?? null,
        creator: existing.creator ?? false
      }
    }
    const session = { seed: crypto.randomBytes(32), key: null, creator: true }
    await this.saveSession(session)
    return session
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

  private async saveSession(session: MeshSession) {
    const transaction = this.database.transaction()
    await transaction.insert<LocalMeshSession>(SESSION, {
      id: SINGLETON,
      seed: session.seed,
      key: session.key,
      creator: session.creator
    })
    await transaction.flush()
  }
}
