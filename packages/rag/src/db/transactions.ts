import { QvacErrorRAG, ERR_CODES, toRagError } from '../errors.js'
import type { HyperDBInstance, HyperDBTransaction } from './db-types.js'

// Unflushed writes are dropped when the transaction closes.
export async function withTransaction<T>(
  db: HyperDBInstance,
  operation: (tx: HyperDBTransaction) => Promise<T>
): Promise<T> {
  return await exclusive(db, async () => {
    let tx: HyperDBTransaction
    try {
      tx = await openTransaction(db)
    } catch (error) {
      throw toRagError(error)
    }
    try {
      return await operation(tx)
    } catch (error) {
      throw toRagError(error)
    } finally {
      await tx.close()
    }
  })
}

// hyperdb's exclusiveTransaction() keeps its write lock when the transaction
// can't start, as on a core the host has closed, and every later write and
// close() waits on it forever. Writes queue here first, so the lock is free
// when one is taken, and a closed core fails before it is.
const queues = new WeakMap<HyperDBInstance, Promise<unknown>>()

function exclusive<T>(db: HyperDBInstance, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(db) ?? Promise.resolve()).then(run)
  const settled = next.catch(() => {})
  queues.set(db, settled)
  void settled.then(() => {
    if (queues.get(db) === settled) queues.delete(db)
  })
  return next
}

function openTransaction(db: HyperDBInstance): Promise<HyperDBTransaction> {
  const core = db.core
  if (!core || core.closing || core.closed) {
    throw new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: 'the Corestore was closed before the RAG'
    })
  }
  return db.exclusiveTransaction()
}
