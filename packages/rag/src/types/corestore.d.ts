// Types the untyped `corestore` module for this package's own compile and
// tests. The member shapes are owned in adapters/database/db-types.ts (which
// ships); here they are bound to the module specifier plus its default.
declare module 'corestore' {
  export type { Hypercore, ReplicationStream } from '../adapters/database/db-types.js'
  const Corestore: new (
    storage: string,
    options?: Record<string, unknown>
  ) => import('../adapters/database/db-types.js').Corestore
  export default Corestore
}
