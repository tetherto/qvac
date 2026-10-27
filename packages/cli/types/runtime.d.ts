interface ImportMeta {
  asset(specifier: string): string
  cache: Record<string, import('bare-module')>
}
// Ambient var declares both Bare and globalThis.Bare, as supplied by the runtime.
// lunte-disable-next-line no-var
declare var Bare: { argv: string[]; platform: string; exit(code?: number): never }
declare module '#fs' {
  import fs from 'node:fs'
  export default fs
}
declare module '#path' {
  import path from 'node:path'
  export default path
}
declare module '#os' {
  import os from 'node:os'
  export default os
}
declare module '#process' {
  import process from 'node:process'
  export default process
}
declare module '#child_process' {
  export * from 'node:child_process'
}
declare module '#url' {
  export * from 'node:url'
}
declare module '#abort-controller' {
  export const AbortController: typeof globalThis.AbortController
}

declare module '#config-import' {
  export function importConfig(url: string): Promise<{ default: unknown }>
  export function resolveFrom(specifier: string, parentURL: string): Promise<string> | string
}

declare module 'bare-supervisor/runner/sidecar' {
  import type { Transport } from '@qvac/harness/rpc'
  export default function run(
    entry: string,
    args: string[],
    logger: unknown
  ): {
    ipc: Awaited<ReturnType<Transport>> & { ready: Promise<void> }
    exit: Promise<number>
    kill(): void
  }
}

declare module 'corestore' {
  export default class Corestore {
    constructor(path: string)
    replicate(connection: unknown): unknown
    close(): Promise<void>
  }
}
declare module 'hyperswarm' {
  export default class Hyperswarm {
    on(event: 'connection', listener: (connection: unknown) => void): this
    join(key: Uint8Array): unknown
    destroy(): Promise<void>
  }
}
declare module 'fs-native-lock' {
  export default class LockFile {
    constructor(path: string)
    lock(): Promise<void>
    unlock(): Promise<void>
  }
}

declare module 'fs-native-extensions' {
  const fsx: { tryLock(fd: number): boolean; unlock(fd: number): void }
  export default fsx
}
