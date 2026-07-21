declare module 'hrpc'
declare module 'hyperdispatch'
declare module 'hyperschema'
declare module 'hyperdb/builder'

declare module 'bare-stow/host' {
  import type Sidecar from 'bare-sidecar'
  import type { Duplex } from 'streamx'

  export interface IPC extends Duplex {
    readonly ready: Promise<void>
    terminate(): Promise<number | undefined>
  }

  export function wrap(stream: Sidecar): IPC
}

declare module 'hypercore-crypto' {
  export type KeyPair = { readonly publicKey: Buffer; readonly secretKey: Buffer }
  export function keyPair(seed?: Buffer): KeyPair
  export function discoveryKey(publicKey: Buffer): Buffer
  export function hash(values: Buffer | string | Array<Buffer | string>): Buffer
  export function randomBytes(length: number): Buffer
  export function namespace(name: Buffer | string, count: 2): [Buffer, Buffer]
  const crypto: {
    keyPair(seed?: Buffer): KeyPair
    discoveryKey(publicKey: Buffer): Buffer
    hash(values: Buffer | string | Array<Buffer | string>): Buffer
    randomBytes(length: number): Buffer
    namespace(name: Buffer | string, count: 2): [Buffer, Buffer]
  }
  export default crypto
}

declare module 'hypercore-storage' {
  export default class CorestoreStorage {
    constructor(storagePath: string)
    readonly rocks: { columnFamily(name: string): object }
    close(): Promise<void>
  }
}

declare module 'corestore' {
  import type CorestoreStorage from 'hypercore-storage'
  export default class Corestore {
    constructor(storage: string | CorestoreStorage)
    readonly manifestVersion: number
    ready(): Promise<void>
    createKeyPair(name: string): Promise<{
      readonly publicKey: Buffer
      readonly secretKey: Buffer
    }>
    namespace(name: string | Buffer): Corestore
    close(): Promise<void>
  }
}

declare module 'hypercore' {
  export default class Hypercore {
    static key(manifest: {
      readonly version: number
      readonly signers: ReadonlyArray<{ readonly publicKey: Buffer }>
    }): Buffer
  }
}

declare module 'hyperswarm' {
  import type { Duplex } from 'streamx'
  export type BootstrapNode = { readonly host: string; readonly port: number }
  export type KeyPair = { readonly publicKey: Buffer; readonly secretKey: Buffer }
  export default class Hyperswarm {
    constructor(options?: {
      readonly bootstrap?: ReadonlyArray<BootstrapNode>
      readonly keyPair?: KeyPair
    })
    readonly connections: ReadonlyArray<Duplex>
    on(event: 'connection', listener: (stream: Duplex) => void): void
    join(topic: Buffer, options: { readonly server: boolean; readonly client: boolean }): object
    destroy(): Promise<void>
  }
}

declare module 'hyperdb' {
  export interface HyperDBStream<T> extends AsyncIterable<T> {
    toArray(): Promise<T[]>
  }
  export default class HyperDB {
    static rocks(storage: object, definition: object): HyperDB
    static bee2(bee: object, definition: object, options?: { autoUpdate?: boolean }): HyperDB
    readonly closed: boolean
    get<T extends object>(collection: string, query: object): Promise<T | null>
    find<T extends object>(collectionOrIndex: string): HyperDBStream<T>
    insert<T extends object>(collection: string, document: T): Promise<void>
    transaction(): HyperDB
    flush(): Promise<void>
    close(): Promise<void>
    watch(listener: () => void): void
    unwatch(listener: () => void): void
  }
}

declare module 'autobee' {
  import type ReadyResource from 'ready-resource'
  import type { Duplex } from 'streamx'
  export interface AutobeeView extends object {}
  export interface AutobeeNode {
    readonly value: Buffer | null
    readonly key: Buffer
  }
  export interface AutobeeHost {
    addWriter(key: Buffer, options?: { readonly isIndexer?: boolean }): void
  }
  export interface AutobeeOptions<T> {
    readonly open: (view: AutobeeView) => T
    readonly apply: (
      nodes: ReadonlyArray<AutobeeNode>,
      view: T,
      host: AutobeeHost
    ) => Promise<void>
    readonly keyPair: { readonly publicKey: Buffer; readonly secretKey: Buffer }
    readonly encrypted: boolean
    readonly encryptionKey: Buffer
  }
  export default class Autobee<T> extends ReadyResource {
    constructor(store: object, key: Buffer | null, options: AutobeeOptions<T>)
    readonly key: Buffer
    readonly discoveryKey: Buffer
    readonly writable: boolean
    readonly view: T
    append(data: Buffer): Promise<void>
    update(): Promise<void>
    replicate(stream: Duplex): void
  }
}

declare module 'blind-pairing' {
  import type Hyperswarm from 'hyperswarm'
  import type ReadyResource from 'ready-resource'

  interface CandidateRequest {
    once(event: 'rejected', listener: (error: Error) => void): void
  }

  interface Member {
    ready(): Promise<void>
    flushed(): Promise<void>
    close(): Promise<void>
  }

  interface PairingRequest {
    readonly inviteId: Buffer
    readonly id: Buffer
    readonly userData: Buffer
    open(publicKey: Buffer): Buffer
    confirm(options: {
      readonly key: Buffer
      readonly encryptionKey: Buffer
    }): void
    deny(options?: { readonly status?: number }): void
  }

  export default class BlindPairing extends ReadyResource {
    constructor(swarm: Hyperswarm)
    static createInvite(key: Buffer, options?: { readonly expires?: number }): {
      readonly id: Buffer
      readonly invite: Buffer
      readonly publicKey: Buffer
      readonly discoveryKey: Buffer
    }
    static decodeInvite(invite: Buffer): {
      readonly expires: number
    }
    addMember(options: {
      readonly discoveryKey: Buffer
      readonly onadd: (request: PairingRequest) => void | Promise<void>
    }): Member
    addCandidate(options: {
      readonly invite: Buffer
      readonly userData: Buffer
      readonly onadd: (result: {
        readonly key: Buffer
        readonly encryptionKey: Buffer
      }) => void | Promise<void>
    }): ReadyResource & { readonly request: CandidateRequest }
  }
}

declare module 'brittle' {
  export interface Test {
    ok(value: unknown, message?: string): boolean
    absent(value: unknown, message?: string): boolean
    is(actual: unknown, expected: unknown, message?: string): boolean
    alike(actual: unknown, expected: unknown, message?: string): boolean
    exception(value: Promise<unknown>, expected?: RegExp, message?: string): Promise<void>
    timeout(milliseconds: number): void
    teardown(callback: () => unknown): void
  }
  type TestFunction = (name: string, callback: (test: Test) => void | Promise<void>) => void
  const test: TestFunction
  export default test
}

declare module 'test-tmp' {
  import type { Test } from 'brittle'
  export default function tmp(test?: Test): Promise<string>
}

declare module 'hyperdht/testnet.js' {
  import type { Test } from 'brittle'
  interface Testnet {
    readonly bootstrap: ReadonlyArray<{ readonly host: string; readonly port: number }>
  }
  export default function createTestnet(
    size: number,
    options: { teardown: Test['teardown'] }
  ): Promise<Testnet>
}
