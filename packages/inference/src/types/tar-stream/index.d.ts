// tar-stream ships no type declarations. Minimal surface covering the extract
// path used by `utils/archive.ts` (plus a loose pack for completeness).
// Extract/Pack are streamx streams at runtime, but streamx's Writable/Readable
// carry nominal private brands an interface can't satisfy, so the pipe sites in
// archive.ts cast to the stream type rather than this shim declaring `extends`.
declare module 'tar-stream' {
  interface Headers {
    name: string
    type?: string
    size?: number
    [key: string]: unknown
  }

  interface Extract {
    on(
      event: 'entry',
      listener: (headers: Headers, stream: import('bare-stream').Readable, next: () => void) => void
    ): this
    on(event: 'finish', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
    write(chunk: unknown): boolean
    end(): void
    destroy(error?: Error): void
  }

  interface Pack {
    entry(headers: Headers, buffer?: unknown, callback?: (err?: Error | null) => void): unknown
    finalize(): void
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  export function extract(): Extract
  export function pack(): Pack

  const tarStream: { extract: typeof extract; pack: typeof pack }
  export default tarStream
}
