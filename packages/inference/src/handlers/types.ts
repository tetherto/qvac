import type { AbortSignalLike, Request, Response } from '@/schemas/index'

/** What dispatch passes a stream handler after its request. */
export interface StreamHandlerContext {
  /**
   * Aborts when the caller stops reading. Dispatch ends the stream on it either
   * way. A handler that begins a registry context passes it as `parentSignal`;
   * one that waits on a source outside the registry (a log subscription) listens
   * to it, so the wait ends and its cleanup runs.
   */
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
}
