// bare-stdio ships no type declarations. Minimal surface the examples use:
// `io.out` / `io.err` write streams for stdout / stderr.
declare module 'bare-stdio' {
  interface StdioWriteStream {
    write(data: string): boolean
  }
  interface IO {
    out: StdioWriteStream
    err: StdioWriteStream
  }
  const io: IO
  export default io
}
