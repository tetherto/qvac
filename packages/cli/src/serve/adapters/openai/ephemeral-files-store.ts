import { randomBytes } from 'node:crypto'

export interface EphemeralFileRecord {
  data: Buffer
  fileName: string
  purpose: string
  createdAtMs: number
}

export interface EphemeralFilesStore {
  /** Store bytes and return an OpenAI-shaped `file-…` id. */
  put: (record: Omit<EphemeralFileRecord, 'createdAtMs'>) => string
  /** Return the record if present; does not remove. */
  get: (id: string) => EphemeralFileRecord | null
  /** Return all current records (newest first), without their bytes. */
  list: () => Array<{ id: string; record: EphemeralFileRecord }>
  /** Remove a file by id if present. */
  remove: (id: string) => void
}

export function createEphemeralFilesStore (nowMs: () => number = () => Date.now()): EphemeralFilesStore {
  const map = new Map<string, EphemeralFileRecord>()

  return {
    put (record) {
      const id = `file-${randomBytes(12).toString('hex')}`
      map.set(id, {
        data: record.data,
        fileName: record.fileName,
        purpose: record.purpose,
        createdAtMs: nowMs()
      })
      return id
    },
    get (id) {
      return map.get(id) ?? null
    },
    list () {
      return Array.from(map.entries())
        .map(([id, record]) => ({ id, record }))
        .sort((a, b) => b.record.createdAtMs - a.record.createdAtMs)
    },
    remove (id) {
      map.delete(id)
    }
  }
}
