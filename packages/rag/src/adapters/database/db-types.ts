// Owned type surface for the untyped `corestore` and `hyperdb` deps. Only the
// members this adapter uses are described; opaque records are generic with an
// `unknown` default.

export interface ReplicationStream {
  pipe(destination: ReplicationStream): ReplicationStream
  destroy(): void
}

export interface Hypercore {
  replicate(isInitiator: boolean): ReplicationStream
}

export interface Corestore {
  ready(): Promise<void>
  get(options: { name: string }): Hypercore
  close(): Promise<void>
}

// hyperdb

export interface HyperDBReader {
  get<T = unknown>(collection: string, query: object): Promise<T | null>
  find<T = unknown>(collection: string, query?: object): { toArray(): Promise<T[]> }
  findOne<T = unknown>(index: string, query: object): Promise<T | null>
}

export interface HyperDBTransaction extends HyperDBReader {
  insert(collection: string, record: object): Promise<void>
  delete(collection: string, query: object): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

export interface HyperDBInstance {
  readonly core: Hypercore
  ready(): Promise<void>
  close(): Promise<void>
  snapshot(): HyperDBReader
  exclusiveTransaction(): Promise<HyperDBTransaction>
}
