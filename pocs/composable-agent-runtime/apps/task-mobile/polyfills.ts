// Hermes ships no global `Buffer`. The durable-work profile carries payloads as
// Buffers, and the Sync client assumes the global exists, so install it before
// anything else evaluates.
import { Buffer } from 'buffer'

if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer
}
