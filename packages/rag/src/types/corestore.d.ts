// Types the untyped `corestore` module for this package's own compile and
// tests. The shapes this package needs are owned in db/db-types.ts (which
// ships); tests also close the store they create.
declare module 'corestore' {
  const Corestore: new (
    storage: string,
    options?: Record<string, unknown>
  ) => import('../db/db-types.js').Corestore & { close(): Promise<void> }
  export default Corestore
}
