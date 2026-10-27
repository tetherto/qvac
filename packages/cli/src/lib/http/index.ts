import type { IncomingMessage, Server, ServerResponse, IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import type { ZodType, output, input } from 'zod'
import { createServer } from './server.js'
export {
  validatorCompiler,
  serializerCompiler,
  hasSchemaValidationErrors,
  isResponseSerializationError
} from './schema.js'
export type { HttpSchemaValidationError, HttpErrorShape } from './schema.js'
export type { MultipartPart } from './multipart.js'

export interface HttpRequestGeneric {
  Body?: unknown
  Querystring?: unknown
  Params?: unknown
}
export interface HttpContextConfig {}
export interface HttpSchema {
  body?: ZodType
  querystring?: ZodType
  params?: ZodType
  headers?: ZodType
  response?: Record<string | number, ZodType>
  hide?: boolean
  tags?: readonly string[]
  summary?: string
  description?: string
  consumes?: readonly string[]
  produces?: readonly string[]
  [key: string]: unknown
}
export interface HttpRequest<G extends HttpRequestGeneric = HttpRequestGeneric> {
  body: G extends { Body: infer B } ? B : unknown
  query: G extends { Querystring: infer Q } ? Q : Record<string, unknown>
  params: G extends { Params: infer P } ? P : Record<string, unknown>
  headers: Record<string, string | undefined>
  raw: IncomingMessage
  socket: Socket
  method: string
  url: string
  server: HttpServer
  routeOptions: { config: HttpContextConfig; url?: string; schema?: HttpSchema }
  parts(): AsyncIterable<import('./multipart.js').MultipartPart>
}
export interface HttpReply {
  raw: ServerResponse
  statusCode: number
  readonly sent: boolean
  code(status: number): this
  status(status: number): this
  header(name: string, value: string | number | readonly string[]): this
  type(contentType: string): this
  send(payload?: unknown): this
  hijack(): this
}
export type HookDone = (error?: Error) => void
export type HttpHook<G extends HttpRequestGeneric = HttpRequestGeneric> = (
  req: HttpRequest<G>,
  reply: HttpReply,
  done: HookDone
) => unknown
export type preValidationAsyncHookHandler = (req: HttpRequest, reply: HttpReply) => Promise<void>
export type preHandlerAsyncHookHandler = preValidationAsyncHookHandler
export type HttpHandler<G extends HttpRequestGeneric = HttpRequestGeneric> = (
  request: HttpRequest<G>,
  reply: HttpReply
) => unknown
export type HttpPlugin<O = Record<string, never>> = (app: HttpServer, options: O) => unknown
export interface RouteOptions<S extends HttpSchema = HttpSchema> {
  schema?: S
  config?: HttpContextConfig
  preValidation?: HttpHook<Unparsed<S>> | readonly HttpHook<Unparsed<S>>[]
  preHandler?: HttpHook<Inferred<S>> | readonly HttpHook<Inferred<S>>[]
  onRequest?: HttpHook<Unparsed<S>> | readonly HttpHook<Unparsed<S>>[]
  bodyLimit?: number
}
type Unparsed<S extends HttpSchema> = {
  Body: S extends { body: infer B extends ZodType } ? input<B> : unknown
  Querystring: Record<string, unknown>
  Params: Record<string, unknown>
}
type Inferred<S extends HttpSchema> = {
  Body: S extends { body: infer B extends ZodType } ? output<B> : unknown
  Querystring: S extends { querystring: infer Q extends ZodType }
    ? output<Q>
    : Record<string, unknown>
  Params: S extends { params: infer P extends ZodType } ? output<P> : Record<string, unknown>
}
export interface RouteMethod {
  <S extends HttpSchema>(
    url: string,
    options: RouteOptions<S> & { schema: S },
    handler: HttpHandler<Inferred<S>>
  ): HttpServer
  <G extends HttpRequestGeneric = HttpRequestGeneric>(
    url: string,
    options: RouteOptions,
    handler: HttpHandler<G>
  ): HttpServer
  <G extends HttpRequestGeneric = HttpRequestGeneric>(
    url: string,
    handler: HttpHandler<G>
  ): HttpServer
}
export interface InjectOptions {
  method?: string
  url: string
  payload?: unknown
  headers?: Record<string, string | number | readonly string[] | undefined>
}
export interface InjectResponse {
  statusCode: number
  headers: IncomingHttpHeaders
  body: string
  payload: string
  rawPayload: Buffer
  // JSON has no runtime type information; callers can supply their response contract.
  json<T = any>(): T
}
export interface HttpServer {
  server: Server
  log: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  get: RouteMethod
  post: RouteMethod
  delete: RouteMethod
  register<O>(plugin: HttpPlugin<O>, options?: O): Promise<void>
  decorate(name: string, value: unknown): this
  addHook(name: 'onRequest' | 'preValidation' | 'preHandler' | 'onResponse', hook: HttpHook): this
  addHook(name: 'onClose', hook: (app: HttpServer, done: HookDone) => unknown): this
  setErrorHandler(
    handler: (
      error: import('./schema.js').HttpErrorShape,
      req: HttpRequest,
      reply: HttpReply
    ) => unknown
  ): this
  setNotFoundHandler(handler: HttpHandler): this
  setOpenApiDocument(document: Record<string, unknown>): this
  swagger(): Record<string, unknown>
  printRoutes(options?: { commonPrefix?: boolean }): string
  ready(): Promise<void>
  listen(options: { port: number; host?: string }): Promise<string>
  close(): Promise<void>
  inject(options: InjectOptions | string): Promise<InjectResponse>
}
export interface ServerOptions {
  bodyLimit?: number
  multipart?: {
    fileSize?: number
    files?: number
    fields?: number
    fieldSize?: number
    headerSize?: number
  }
  logger?: boolean
}
export default function createHttpServer(options: ServerOptions = {}): HttpServer {
  return createServer(options)
}
