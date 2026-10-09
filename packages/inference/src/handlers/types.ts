import type { AbortSignalLike, Request, Response } from '@/schemas/index'

/** What dispatch passes a stream handler that declares `endsOnAbort`. */
export interface StreamHandlerContext {
  /**
   * Aborts when the caller stops reading. The handler ends its stream on it and
   * releases what it waits on, such as a log subscription.
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
  // The handler ends its stream when the caller aborts, so dispatch passes it a
  // `StreamHandlerContext`. Every other stream runs to its end: ending a plugin
  // stream early would free its admission slot while the native job still runs,
  // so an inference run is stopped with `cancel` instead.
  endsOnAbort?: boolean
}
