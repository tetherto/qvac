// Owned type surface for the untyped `corestore` and `hyperdb` deps. Only the
// members this package uses are described.

export interface Hypercore {
  // Set once ready() resolves; identifies the core across Corestore sessions.
  id: string | null
  ready(): Promise<void>
  close(): Promise<void>
}

export interface Corestore {
  ready(): Promise<void>
  get(options: { name: string }): Hypercore
  // Shared by every session of one Corestore; distinct per storage directory.
  storage?: object
}

export interface HyperDBStream<T> extends AsyncIterable<T> {
  toArray(): Promise<T[]>
}

export interface HyperDBReader {
  get<T = unknown>(collection: string, query: object): Promise<T | null>
  find<T = unknown>(collection: string, query?: object): HyperDBStream<T>
  close(): Promise<void>
}

export interface HyperDBTransaction extends HyperDBReader {
  insert(collection: string, record: object): Promise<void>
  delete(collection: string, query: object): Promise<void>
  flush(): Promise<void>
}

export interface HyperDBInstance {
  ready(): Promise<void>
  close(): Promise<void>
  snapshot(): HyperDBReader
  exclusiveTransaction(): Promise<HyperDBTransaction>
}
