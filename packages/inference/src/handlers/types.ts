import type { AbortSignalLike, Request, Response } from '@/schemas/index'

/** Passed to a stream handler with `endsOnAbort`. */
export interface StreamHandlerContext {
  /** Aborts when the caller stops reading. */
  signal?: AbortSignalLike
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ReplyHandler = (request: any, ...args: any[]) => Promise<Response> | Response
export type StreamHandler = (request: any, ...args: any[]) => AsyncGenerator<Response>
export type ProgressHandler = (request: any, ...args: any[]) => Promise<Response>
export type DuplexStreamHandler = (request: any, inputStream: any) => AsyncGenerator<Response>
/* eslint-enable @typescript-eslint/no-explicit-any */

export type HandlerEntry = {
  type: 'reply' | 'stream' | 'duplex'
  handler: ReplyHandler | StreamHandler | ProgressHandler | DuplexStreamHandler
  supportsProgress?: boolean | ((request: Request) => boolean)
  // A capability that runs on the loaded model's plugin. Such handlers already
  // record their own profiling inside plugin dispatch, so local dispatch does
  // not wrap them again.
  pluginOp?: boolean
  // Ends its stream on the caller's abort. Not for plugin streams: the native
  // job would outlive its freed slot; those stop through `cancel`.
  endsOnAbort?: boolean
}
