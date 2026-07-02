import type BareBuffer from 'bare-buffer'

// Bare exposes `Buffer` as a global (from bare-buffer), like Node. Declare it so
// first-party code can use the global without importing it everywhere.
declare global {
  type Buffer = BareBuffer
  const Buffer: typeof BareBuffer
}

export {}
