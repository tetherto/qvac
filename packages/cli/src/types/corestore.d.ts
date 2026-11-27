declare module 'corestore' {
  import type { Corestore as RagCorestore } from '@qvac/rag'

  export default class Corestore implements RagCorestore {
    constructor(storage: string)
    ready(): Promise<void>
    get: RagCorestore['get']
    close(): Promise<void>
  }
}
