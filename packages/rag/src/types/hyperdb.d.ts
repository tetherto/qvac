// Types the untyped `hyperdb` module for this package's own compile and tests.
// The member shapes are owned in db/db-types.ts (which ships);
// here they are bound to the module specifier plus its default factory.
declare module 'hyperdb' {
  export type { HyperDBInstance, HyperDBReader, HyperDBTransaction } from '../db/db-types.js'
  const HyperDB: {
    bee(
      core: import('../db/db-types.js').Hypercore,
      spec: unknown,
      opts?: { autoUpdate?: boolean }
    ): import('../db/db-types.js').HyperDBInstance
  }
  export default HyperDB
}
