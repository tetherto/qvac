import { randomBytes } from 'node:crypto'

export interface VectorStoreExpiresAfter {
  anchor: 'last_active_at'
  days: number
}

export interface VectorStoreMeta {
  id: string
  createdAt: number
  name: string | null
  metadata: Record<string, string>
  expiresAfter: VectorStoreExpiresAfter | null
  expiresAt: number | null
  lastActiveAt: number
  /**
   * Embedding alias the store was first ingested with. Null until the first
   * successful attach records it. Used to reject silent-mismatch searches
   * if the operator swaps the default embedding mid-flight.
   */
  embeddingAlias: string | null
}

export interface CreateVectorStoreInput {
  id?: string
  name?: string | null
  metadata?: Record<string, string>
  expiresAfter?: VectorStoreExpiresAfter | null
}

export interface UpdateVectorStoreInput {
  name?: string | null
  metadata?: Record<string, string> | null
  expiresAfter?: VectorStoreExpiresAfter | null
}

export interface VectorStoresStore {
  create: (input?: CreateVectorStoreInput) => VectorStoreMeta
  get: (id: string) => VectorStoreMeta | null
  update: (id: string, input: UpdateVectorStoreInput) => VectorStoreMeta | null
  delete: (id: string) => boolean
  list: () => VectorStoreMeta[]
  touch: (id: string) => void
  /**
   * Record the embedding alias used at first attach. No-op if id is unknown
   * or if an alias is already recorded (idempotent: never overwrites).
   */
  setEmbedding: (id: string, alias: string) => void
}

const ID_PREFIX = 'vs_'
const ID_RANDOM_BYTES = 12
const MAX_ID_LENGTH = 64
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const TRAVERSAL_PATTERNS = ['..', '/', '\\', '\0']

export type InvalidVectorStoreIdKind = 'invalid' | 'duplicate'

export class InvalidVectorStoreIdError extends Error {
  readonly kind: InvalidVectorStoreIdKind
  constructor (id: string, reason: string, kind: InvalidVectorStoreIdKind = 'invalid') {
    super(`Invalid vector store id "${id}": ${reason}`)
    this.name = 'InvalidVectorStoreIdError'
    this.kind = kind
  }
}

export function generateVectorStoreId (): string {
  return ID_PREFIX + randomBytes(ID_RANDOM_BYTES).toString('hex')
}

export function idToWorkspace (id: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new InvalidVectorStoreIdError(String(id), 'must be a non-empty string')
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new InvalidVectorStoreIdError(id, `must be at most ${MAX_ID_LENGTH} characters`)
  }
  for (const bad of TRAVERSAL_PATTERNS) {
    if (id.includes(bad)) {
      throw new InvalidVectorStoreIdError(id, `must not contain "${bad}"`)
    }
  }
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new InvalidVectorStoreIdError(
      id,
      'must match [a-zA-Z0-9_-]{1,64}'
    )
  }
  return id
}

function clone (meta: VectorStoreMeta): VectorStoreMeta {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    name: meta.name,
    metadata: { ...meta.metadata },
    expiresAfter: meta.expiresAfter ? { ...meta.expiresAfter } : null,
    expiresAt: meta.expiresAt,
    lastActiveAt: meta.lastActiveAt,
    embeddingAlias: meta.embeddingAlias
  }
}

function computeExpiresAt (
  baseMs: number,
  expiresAfter: VectorStoreExpiresAfter | null
): number | null {
  if (!expiresAfter) return null
  const days = expiresAfter.days
  if (!Number.isFinite(days) || days <= 0) return null
  return baseMs + Math.floor(days * 24 * 60 * 60 * 1000)
}

export function createVectorStoresStore (
  now: () => number = Date.now
): VectorStoresStore {
  const stores = new Map<string, VectorStoreMeta>()

  function create (input: CreateVectorStoreInput = {}): VectorStoreMeta {
    const id = input.id !== undefined ? idToWorkspace(input.id) : generateVectorStoreId()
    if (stores.has(id)) {
      throw new InvalidVectorStoreIdError(id, 'already exists', 'duplicate')
    }
    const created = now()
    const expiresAfter = input.expiresAfter ?? null
    const meta: VectorStoreMeta = {
      id,
      createdAt: created,
      name: input.name ?? null,
      metadata: { ...(input.metadata ?? {}) },
      expiresAfter,
      expiresAt: computeExpiresAt(created, expiresAfter),
      lastActiveAt: created,
      embeddingAlias: null
    }
    stores.set(id, meta)
    return clone(meta)
  }

  function get (id: string): VectorStoreMeta | null {
    const meta = stores.get(id)
    return meta ? clone(meta) : null
  }

  function update (id: string, input: UpdateVectorStoreInput): VectorStoreMeta | null {
    const meta = stores.get(id)
    if (!meta) return null
    if (input.name !== undefined) {
      meta.name = input.name
    }
    if (input.metadata !== undefined) {
      meta.metadata = input.metadata === null ? {} : { ...input.metadata }
    }
    if (input.expiresAfter !== undefined) {
      meta.expiresAfter = input.expiresAfter
      meta.expiresAt = computeExpiresAt(meta.lastActiveAt, input.expiresAfter)
    }
    return clone(meta)
  }

  function deleteStore (id: string): boolean {
    return stores.delete(id)
  }

  function list (): VectorStoreMeta[] {
    return Array.from(stores.values())
      .map(clone)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  function touch (id: string): void {
    const meta = stores.get(id)
    if (!meta) return
    meta.lastActiveAt = now()
    if (meta.expiresAfter) {
      meta.expiresAt = computeExpiresAt(meta.lastActiveAt, meta.expiresAfter)
    }
  }

  function setEmbedding (id: string, alias: string): void {
    const meta = stores.get(id)
    if (!meta) return
    if (meta.embeddingAlias !== null) return
    meta.embeddingAlias = alias
  }

  return {
    create,
    get,
    update,
    delete: deleteStore,
    list,
    touch,
    setEmbedding
  }
}
