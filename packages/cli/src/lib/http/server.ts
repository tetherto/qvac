import { createServer as nodeServer, request as nodeRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import type {
  HttpServer,
  HttpRequest,
  HttpReply,
  HttpHook,
  HttpHandler,
  HttpPlugin,
  HttpSchema,
  RouteOptions,
  RouteMethod,
  InjectOptions,
  InjectResponse,
  ServerOptions,
  HookDone
} from './index.js'
import { multipartParts } from './multipart.js'
import { validate, serializerCompiler, operation } from './schema.js'
import type { HttpErrorShape } from './schema.js'

type HookName = 'onRequest' | 'preValidation' | 'preHandler' | 'onResponse'
type LifecycleHook = (server: HttpServer, done: HookDone) => unknown
type ErrorHandler = (error: HttpErrorShape, req: HttpRequest, reply: HttpReply) => unknown
interface Route {
  method: string
  url: string
  pattern: RegExp
  names: string[]
  scope: Scope
  options: RouteOptions
  handler: HttpHandler
}

class Reply implements HttpReply {
  private taken = false
  constructor(
    readonly raw: ServerResponse,
    private readonly schema?: HttpSchema
  ) {}
  get statusCode() {
    return this.raw.statusCode
  }
  set statusCode(value: number) {
    this.raw.statusCode = value
  }
  get sent() {
    return this.taken || this.raw.writableEnded
  }
  code(status: number): this {
    this.raw.statusCode = status
    return this
  }
  status(status: number): this {
    return this.code(status)
  }
  header(name: string, value: string | number | readonly string[]): this {
    this.raw.setHeader(name, value)
    return this
  }
  type(contentType: string): this {
    return this.header('content-type', contentType)
  }
  hijack(): this {
    this.taken = true
    return this
  }
  send(payload?: unknown): this {
    if (this.raw.writableEnded) return this
    if (payload instanceof Readable) {
      this.taken = true
      payload.once('error', (error) => this.raw.destroy(error))
      this.raw.once('close', () => payload.destroy())
      payload.pipe(this.raw)
      return this
    }
    let data: string | Buffer | undefined
    if (payload === undefined) data = undefined
    else if (payload instanceof Uint8Array) data = Buffer.from(payload)
    else if (typeof payload === 'string') data = payload
    else {
      const schema =
        this.schema?.response?.[this.statusCode] ??
        this.schema?.response?.[`${Math.floor(this.statusCode / 100)}xx`] ??
        this.schema?.response?.['default']
      data = schema ? serializerCompiler({ schema })(payload) : JSON.stringify(payload)
      if (!this.raw.hasHeader('content-type')) this.type('application/json; charset=utf-8')
    }
    if (data !== undefined) {
      if (!this.raw.hasHeader('content-type')) {
        this.type(Buffer.isBuffer(data) ? 'application/octet-stream' : 'text/plain; charset=utf-8')
      }
      if (!this.raw.hasHeader('content-length')) {
        this.header('content-length', Buffer.byteLength(data))
      }
    }
    this.raw.end(data)
    return this
  }
}

function hooks(value: HttpHook | readonly HttpHook[] | undefined): readonly HttpHook[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value as HttpHook]
}
function invoke(
  fn: (...args: never[]) => unknown,
  context: unknown,
  args: unknown[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done: HookDone = (error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    try {
      const result = Reflect.apply(fn, context, [...args, done]) as unknown
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(result).then(
          () => done(),
          (error: unknown) => done(asError(error))
        )
      } else if (fn.length <= args.length) done()
    } catch (error) {
      done(asError(error))
    }
  })
}
function asError(error: unknown): HttpErrorShape {
  return error instanceof Error ? error : new Error(String(error))
}
function bodyError(code: string, message: string, statusCode = 400): HttpErrorShape {
  return Object.assign(new Error(message), { code, statusCode })
}
function readBody(raw: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const parts: Buffer[] = []
    const fail = (error: Error) => {
      cleanup()
      raw.resume()
      reject(error)
    }
    const data = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit) {
        fail(bodyError('HTTP_BODY_TOO_LARGE', 'Request body exceeds the configured limit', 413))
        return
      }
      parts.push(chunk)
    }
    const end = () => {
      cleanup()
      resolve(Buffer.concat(parts, bytes))
    }
    const aborted = () => fail(bodyError('HTTP_REQUEST_ABORTED', 'Request aborted'))
    const cleanup = () => {
      raw.off('data', data)
      raw.off('end', end)
      raw.off('error', fail)
      raw.off('aborted', aborted)
    }
    if (Number(raw.headers['content-length'] ?? 0) > limit) {
      fail(bodyError('HTTP_BODY_TOO_LARGE', 'Request body exceeds the configured limit', 413))
      return
    }
    raw.on('data', data)
    raw.once('end', end)
    raw.once('error', fail)
    raw.once('aborted', aborted)
  })
}
function compilePath(url: string) {
  const names: string[] = []
  const pattern = url
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1))
        return '([^/]+)'
      }
      if (part === '*') {
        names.push('*')
        return '(.*)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { pattern: new RegExp(`^${pattern}$`), names }
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw Object.assign(bodyError('HTTP_INVALID_URL', 'Malformed URL parameter encoding'), {
      validation: []
    })
  }
}

function routeRank(url: string): string {
  return url
    .split('/')
    .map((part) => (part === '*' ? '0' : part.startsWith(':') ? '1' : '2'))
    .join('')
}

class Scope {
  readonly server: Server
  readonly log = {
    info: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {}
  }
  private readonly ownHooks = new Map<HookName, HttpHook[]>()
  private readonly closeHooks: LifecycleHook[] = []
  private readonly routes: Route[]
  private readonly children: Scope[] = []
  private errorHandler?: ErrorHandler
  private notFoundHandler?: HttpHandler
  private document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: { title: 'API', version: '1.0.0' }
  }
  private readyPromise?: Promise<void>
  private listenPromise?: Promise<string>
  private closePromise?: Promise<void>
  private closing = false
  readonly get = this.method('GET')
  readonly post = this.method('POST')
  readonly delete = this.method('DELETE')

  constructor(
    private readonly settings: ServerOptions,
    private readonly parent: Scope | null = null
  ) {
    this.routes = parent?.routes ?? []
    this.server =
      parent?.server ??
      nodeServer((req, res) => {
        void this.dispatch(req, res)
      })
    if (parent) Object.setPrototypeOf(this, parent)
  }
  private public(): HttpServer {
    return this as unknown as HttpServer
  }
  private root(): Scope {
    return this.parent?.root() ?? this
  }
  private method(method: string): RouteMethod {
    return ((url: string, options: RouteOptions | HttpHandler, handler?: HttpHandler) => {
      if (this.root().readyPromise) throw new Error('Cannot add routes after server.ready()')
      const routeOptions = typeof options === 'function' ? {} : options
      const routeHandler = typeof options === 'function' ? options : handler
      if (!routeHandler) throw new Error(`Missing handler for ${method} ${url}`)
      const fullPath = url
      if (this.routes.some((route) => route.method === method && route.url === fullPath)) {
        throw new Error(`Duplicate route ${method} ${fullPath}`)
      }
      this.routes.push({
        method,
        url: fullPath,
        ...compilePath(fullPath),
        options: routeOptions,
        handler: routeHandler,
        scope: this
      })
      return this.public()
    }) as RouteMethod
  }
  async register<O>(plugin: HttpPlugin<O>, options?: O): Promise<void> {
    const child = new Scope(this.settings, this)
    this.children.push(child)
    await plugin(child.public(), options ?? ({} as O))
  }
  decorate(name: string, value: unknown): this {
    Object.defineProperty(this, name, { value, configurable: true, writable: true })
    return this
  }
  addHook(name: HookName | 'onClose', hook: HttpHook | LifecycleHook): this {
    if (name === 'onClose') this.closeHooks.push(hook as LifecycleHook)
    else {
      const list = this.ownHooks.get(name) ?? []
      list.push(hook as HttpHook)
      this.ownHooks.set(name, list)
    }
    return this
  }
  setErrorHandler(handler: ErrorHandler): this {
    this.errorHandler = handler
    return this
  }
  setNotFoundHandler(handler: HttpHandler): this {
    this.notFoundHandler = handler
    return this
  }
  setOpenApiDocument(document: Record<string, unknown>): this {
    this.root().document = document
    return this
  }
  swagger(): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {}
    for (const route of this.routes) {
      if (route.options.schema?.hide) continue
      const url = route.url.replace(/:([^/]+)/g, '{$1}')
      const group = paths[url] ?? {}
      group[route.method.toLowerCase()] = operation(route.options.schema ?? {}, route.method)
      paths[url] = group
    }
    return { ...this.root().document, paths }
  }
  printRoutes(_options?: { commonPrefix?: boolean }): string {
    return this.routes.map((route) => `${route.url} (${route.method})`).join('\n')
  }
  private chain(): Scope[] {
    return this.parent ? [...this.parent.chain(), this] : [this]
  }
  private async runHooks(
    name: HookName,
    req: HttpRequest,
    reply: HttpReply,
    extra?: HttpHook | readonly HttpHook[]
  ): Promise<void> {
    const list = [
      ...this.chain().flatMap((scope) => scope.ownHooks.get(name) ?? []),
      ...hooks(extra)
    ]
    for (const hook of list) {
      await invoke(hook, this.public(), [req, reply])
      if (name !== 'onResponse' && reply.sent) break
    }
  }
  private async dispatch(raw: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = raw.url?.split('?')[0] ?? '/'
    const method = raw.method ?? 'GET'
    const match = (verb: string) =>
      this.routes
        .filter((entry) => entry.method === verb && entry.pattern.test(pathname))
        .sort((a, b) => routeRank(b.url).localeCompare(routeRank(a.url)))[0]
    const route = match(method) ?? (method === 'HEAD' ? match('GET') : undefined)
    const scope = route?.scope ?? this
    const reply = new Reply(response, route?.options.schema)
    const req = {
      raw,
      socket: raw.socket,
      method,
      url: raw.url ?? '/',
      headers: Object.fromEntries(
        Object.entries(raw.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(', ') : value
        ])
      ),
      body: undefined,
      params: {},
      query: {},
      server: scope.public(),
      routeOptions: {
        config: route?.options.config ?? {},
        ...(route ? { url: route.url, schema: route.options.schema } : {})
      }
    } as unknown as HttpRequest
    let body: Buffer = Buffer.alloc(0)
    req.parts = () =>
      multipartParts(body, req.headers['content-type'] ?? '', this.settings.multipart)
    response.once('finish', () => {
      void scope.runHooks('onResponse', req, reply).catch(() => {})
    })
    try {
      const url = new URL(req.url, 'http://localhost')
      req.query = Object.fromEntries(url.searchParams)
      if (route) {
        const match = route.pattern.exec(pathname)!
        req.params = Object.fromEntries(
          route.names.map((name, index) => [name, decodePathPart(match[index + 1]!)])
        )
      }
      await scope.runHooks('onRequest', req, reply, route?.options.onRequest)
      if (reply.sent) {
        raw.resume()
        return
      }
      body = await readBody(raw, route?.options.bodyLimit ?? this.settings.bodyLimit ?? 1024 * 1024)
      const contentType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
      if (contentType === 'application/json' || contentType?.endsWith('+json')) {
        if (!body.length) throw bodyError('HTTP_EMPTY_JSON_BODY', 'Request body must be valid JSON')
        try {
          req.body = JSON.parse(body.toString('utf8')) as unknown
        } catch {
          throw bodyError('HTTP_INVALID_JSON_BODY', 'Request body must be valid JSON')
        }
      } else if (body.length && contentType !== 'multipart/form-data') {
        req.body = body.toString('utf8')
      }
      await scope.runHooks('preValidation', req, reply, route?.options.preValidation)
      if (reply.sent) return
      const schema = route?.options.schema
      req.headers = validate(schema?.headers, req.headers, 'headers') as Record<
        string,
        string | undefined
      >
      req.body = validate(schema?.body, req.body, 'body')
      req.query = validate(schema?.querystring, req.query, 'querystring') as Record<string, unknown>
      req.params = validate(schema?.params, req.params, 'params') as Record<string, unknown>
      await scope.runHooks('preHandler', req, reply, route?.options.preHandler)
      if (reply.sent) return
      const handler =
        route?.handler ??
        scope
          .chain()
          .reverse()
          .find((ancestor) => ancestor.notFoundHandler)?.notFoundHandler
      const value = handler
        ? await handler(req, reply)
        : reply.code(404).send({ error: 'Not found' })
      if (!reply.sent) reply.send(value)
    } catch (error) {
      try {
        const converted = asError(error)
        const handler = scope
          .chain()
          .reverse()
          .find((ancestor) => ancestor.errorHandler)?.errorHandler
        if (handler) {
          const value = await handler(converted, req, reply)
          if (!reply.sent) reply.send(value)
        } else if (!response.headersSent) {
          reply.code(converted.statusCode ?? 500).send({ error: converted.message })
        } else {
          response.end()
        }
      } catch {
        if (!response.headersSent) {
          response.statusCode = 500
          response.end('Internal server error')
        } else response.destroy()
      }
    }
  }
  ready(): Promise<void> {
    const root = this.root()
    root.readyPromise ??= Promise.resolve()
    return root.readyPromise
  }
  listen(options: { port: number; host?: string }): Promise<string> {
    const root = this.root()
    root.listenPromise ??= (async () => {
      if (root.closing) throw new Error('Server is closed')
      await root.ready()
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          root.server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          root.server.off('error', onError)
          resolve()
        }
        root.server.once('error', onError)
        root.server.once('listening', onListening)
        root.server.listen(options.port, options.host ?? '127.0.0.1')
      })
      const address = root.server.address() as AddressInfo
      return `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`
    })()
    return root.listenPromise
  }
  close(): Promise<void> {
    const root = this.root()
    root.closePromise ??= (async () => {
      root.closing = true
      if (root.listenPromise) await root.listenPromise.catch(() => {})
      if (root.server.listening) {
        await new Promise<void>((resolve, reject) =>
          root.server.close((error) => (error ? reject(error) : resolve()))
        )
      }
      const visit = async (scope: Scope): Promise<void> => {
        for (const child of [...scope.children].reverse()) await visit(child)
        for (const hook of [...scope.closeHooks].reverse()) {
          await invoke(hook, scope.public(), [scope.public()])
        }
      }
      await visit(root)
    })()
    return root.closePromise
  }
  async inject(input: InjectOptions | string): Promise<InjectResponse> {
    const options = typeof input === 'string' ? { url: input } : input
    const base = await this.listen({ port: 0, host: '127.0.0.1' })
    const url = new URL(options.url, base)
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? [...value] : value])
    )
    let data: string | Buffer | undefined
    if (options.payload !== undefined) {
      data = Buffer.isBuffer(options.payload)
        ? options.payload
        : typeof options.payload === 'string'
          ? options.payload
          : JSON.stringify(options.payload)
      if (
        typeof options.payload === 'object' &&
        !Buffer.isBuffer(options.payload) &&
        !headers['content-type']
      ) {
        headers['content-type'] = 'application/json'
      }
      if (!headers['content-length']) headers['content-length'] = Buffer.byteLength(data)
    }
    return new Promise((resolve, reject) => {
      const req = nodeRequest(
        url,
        {
          method: options.method ?? 'GET',
          headers: headers as import('node:http').OutgoingHttpHeaders,
          agent: false
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.once('error', reject)
          res.once('end', () => {
            const rawPayload = Buffer.concat(chunks)
            const payload = rawPayload.toString('utf8')
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              rawPayload,
              payload,
              body: payload,
              json: <T>() => JSON.parse(payload) as T
            })
          })
        }
      )
      req.once('error', reject)
      req.end(data)
    })
  }
}

export function createServer(options: ServerOptions): HttpServer {
  return new Scope(options) as unknown as HttpServer
}
