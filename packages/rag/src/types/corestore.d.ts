// Types the untyped `corestore` module for this package's own compile and
// tests. The member shapes are owned in db/db-types.ts (which
// ships); here they are bound to the module specifier plus its default.
declare module 'corestore' {
  export type { Hypercore, ReplicationStream } from '../db/db-types.js'
  const Corestore: new (
    storage: string,
    options?: Record<string, unknown>
  ) => import('../db/db-types.js').Corestore
  export default Corestore
}
