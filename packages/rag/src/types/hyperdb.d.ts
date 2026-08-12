// Types the untyped `hyperdb` module for this package's own compile and tests.
// The member shapes are owned in adapters/database/db-types.ts (which ships);
// here they are bound to the module specifier plus its default factory.
declare module 'hyperdb' {
  export type {
    HyperDBInstance,
    HyperDBReader,
    HyperDBTransaction
  } from '../adapters/database/db-types.js'
  const HyperDB: {
    bee(
      core: import('../adapters/database/db-types.js').Hypercore,
      spec: unknown,
      opts?: { autoUpdate?: boolean }
    ): import('../adapters/database/db-types.js').HyperDBInstance
  }
  export default HyperDB
}
