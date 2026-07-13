// In the Node/Electron SDK build, core's value-clean surface types some payload
// fields as `bare-buffer`'s `Buffer`. On a non-Bare host those payloads are Node
// buffers, so the SDK build resolves `bare-buffer` to Node's `Buffer` (via a
// `paths` entry in `tsconfig.json`) — that keeps the re-exported schema surface
// type-compatible with the client's Node `Buffer` usage. At runtime this shim is
// inert: the client never imports `bare-buffer`, and the Bare worker resolves the
// real module. It mirrors `bare-buffer`'s dual shape: usable as the default
// (`import Buffer from 'bare-buffer'`) and as a named member
// (`import { Buffer } from 'bare-buffer'`).
import { type Buffer as NodeBuffer } from 'node:buffer'

type Buffer = NodeBuffer
declare const Buffer: typeof NodeBuffer & { Buffer: typeof NodeBuffer }

export = Buffer
