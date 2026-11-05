// Types the untyped `corestore` module for this package's own compile and
// tests. The shapes this package needs are owned in db/db-types.ts (which
// ships); tests also close the store they create and open sessions on it.
declare module 'corestore' {
  interface CorestoreInstance extends Corestore {
    close(): Promise<void>
    session(): CorestoreInstance
  }
  type Corestore = import('../db/db-types.js').Corestore
  const Corestore: new (storage: string, options?: Record<string, unknown>) => CorestoreInstance
  export default Corestore
}
