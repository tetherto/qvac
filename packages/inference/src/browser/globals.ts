// Typed access to the browser APIs the browser build uses. The package
// compiles against Bare's globals, not the DOM library, so each API is
// declared here to the extent it is used and reached through `browser`.

export interface WebStreamReader {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
  cancel(): Promise<void>
}

export interface WebReadableStream {
  getReader(): WebStreamReader
  pipeTo(destination: WebWritableStream): Promise<void>
}

export interface WebWritableStream {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface WebBlob {
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
  slice(start?: number, end?: number): WebBlob
  stream(): WebReadableStream
}

export interface WebFile extends WebBlob {
  readonly name: string
  readonly lastModified: number
}

export interface SyncAccessHandle {
  write(buffer: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

export interface FileHandle {
  readonly kind: 'file'
  getFile(): Promise<WebFile>
  createWritable(): Promise<WebWritableStream>
  /** Dedicated workers only. */
  createSyncAccessHandle(): Promise<SyncAccessHandle>
  move(directory: DirectoryHandle, name: string): Promise<void>
}

export interface DirectoryHandle extends AsyncIterable<[string, FileHandle | DirectoryHandle]> {
  readonly kind: 'directory'
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

export interface FetchResponse {
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly redirected: boolean
  readonly headers: { forEach(callback: (value: string, key: string) => void): void }
  readonly body: WebReadableStream | null
}

export interface FetchInit {
  method?: string
  headers?: Record<string, string>
  redirect?: 'follow'
  signal?: AbortSignal
}

interface AbortSignal {
  readonly aborted: boolean
}

export interface WebAbortController {
  readonly signal: AbortSignal
  abort(): void
}

interface Lock {
  readonly name: string
}

export interface BrowserGlobals {
  navigator: {
    storage: { getDirectory(): Promise<DirectoryHandle> }
    locks?: {
      request(
        name: string,
        options: { ifAvailable: boolean },
        callback: (lock: Lock | null) => Promise<void> | undefined
      ): Promise<void>
    }
    /** Approximate device memory in GiB; Chromium only, capped at 8. */
    deviceMemory?: number
  }
  crypto: { randomUUID(): string }
  fetch(url: string, init: FetchInit): Promise<FetchResponse>
  AbortController: new () => WebAbortController
  AbortSignal: unknown
  URL: typeof URL
}

export const browser = globalThis as unknown as BrowserGlobals
