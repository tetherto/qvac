import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'

import type { HostLogger } from './host-logger.js'
import {
  flattenMessages,
  makeThinkSplitter,
  transformSSEChunk,
  type ChatCompletionBody,
  type SSEChunk,
  type SplitResult,
  type ThinkSplitter
} from './shim.js'

export interface Upstream {
  readonly hostname: string
  readonly port: string
}

export interface ProxyOptions {
  readonly getUpstream: () => Upstream | undefined
  readonly whenUpstream: Promise<void>
  readonly openAICompatTransforms: boolean
  readonly upstreamTimeoutMs: number
  readonly logger: HostLogger
}

export interface StartedOpenAICompatibleProxy {
  readonly port: number
  close: () => Promise<void>
}

type SerializedRunner = (work: () => Promise<void>) => Promise<void>

export function originOf (baseURL: string): Upstream {
  const u = new URL(baseURL)
  return { hostname: u.hostname, port: u.port }
}

function buildForwardHeaders (req: IncomingMessage, bodyLength: number): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }
  delete headers['host']
  delete headers['accept-encoding']
  delete headers['content-length']
  if (bodyLength > 0) headers['content-length'] = String(bodyLength)
  return headers
}

function isInferenceRequest (req: IncomingMessage): boolean {
  return req.method === 'POST' && (req.url ?? '').includes('/chat/completions')
}

function createSerializedRunner (): SerializedRunner {
  let tail: Promise<void> = Promise.resolve()
  return async (work: () => Promise<void>): Promise<void> => {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => {})
    try {
      await work()
    } finally {
      release()
    }
  }
}

function emitSplitResult (result: SplitResult, res: ServerResponse): void {
  if (result.reasoning !== '') {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: result.reasoning }, finish_reason: null }] })}\n\n`)
  }
  if (result.content !== '') {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: result.content } }] })}\n\n`)
  }
}

function emitSSELine (line: string, split: ThinkSplitter, res: ServerResponse): void {
  if (line.startsWith('data:')) {
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      emitSplitResult(split.flush(), res)
      res.write('data: [DONE]\n\n')
      return
    }
    let chunk: SSEChunk
    try {
      chunk = JSON.parse(payload) as SSEChunk
    } catch {
      res.write(`${line}\n`)
      return
    }
    for (const out of transformSSEChunk(chunk, split)) res.write(`data: ${JSON.stringify(out)}\n\n`)
  } else if (line !== '') {
    res.write(`${line}\n`)
  }
}

function pipeResponse (
  upstreamRes: IncomingMessage,
  res: ServerResponse,
  reqStart: number,
  options: Pick<ProxyOptions, 'openAICompatTransforms' | 'logger'>
): void {
  upstreamRes.on('error', () => res.destroy())
  const outHeaders: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    if (value !== undefined && key !== 'content-encoding') outHeaders[key] = value
  }
  const isSSE = (upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')
  if (options.openAICompatTransforms && isSSE) delete outHeaders['content-length']
  res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)

  if (!options.openAICompatTransforms || !isSSE) {
    upstreamRes.on('end', () => options.logger.trace(`done total=${((Date.now() - reqStart) / 1000).toFixed(1)}s`))
    upstreamRes.pipe(res)
    return
  }

  const split = makeThinkSplitter()
  let lineBuf = ''
  upstreamRes.setEncoding('utf8')
  upstreamRes.on('data', (str: string) => {
    lineBuf += str
    let nl: number
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl)
      lineBuf = lineBuf.slice(nl + 1)
      emitSSELine(line, split, res)
    }
  })
  upstreamRes.on('end', () => {
    if (lineBuf !== '') emitSSELine(lineBuf, split, res)
    emitSplitResult(split.flush(), res)
    res.end()
    options.logger.trace(`done total=${((Date.now() - reqStart) / 1000).toFixed(1)}s`)
  })
}

function writeProxyError (res: ServerResponse, statusCode: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message } }))
}

async function forwardToUpstream (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  reqStart: number,
  upstream: Upstream,
  options: ProxyOptions
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const proxyReq = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: buildForwardHeaders(req, body.length)
      },
      (proxyRes) => {
        options.logger.trace(`<- ${proxyRes.statusCode ?? '?'} headers=${((Date.now() - reqStart) / 1000).toFixed(1)}s`)
        proxyRes.on('end', finish)
        proxyRes.on('close', finish)
        proxyRes.on('error', finish)
        pipeResponse(proxyRes, res, reqStart, options)
      }
    )
    const timer = setTimeout(() => {
      proxyReq.destroy()
      writeProxyError(res, 504, `qvac serve proxy timeout after ${options.upstreamTimeoutMs}ms`)
      finish()
    }, options.upstreamTimeoutMs)
    timer.unref()
    proxyReq.on('error', (err) => {
      writeProxyError(res, 502, `qvac serve proxy error: ${String(err)}`)
      finish()
    })
    res.on('close', () => {
      proxyReq.destroy()
      finish()
    })
    if (body.length > 0) proxyReq.write(body)
    proxyReq.end()
  })
}

async function handleRequest (
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  reqStart: number,
  options: ProxyOptions,
  runInference: SerializedRunner
): Promise<void> {
  let body = rawBody
  const contentType = req.headers['content-type'] ?? ''
  if (options.openAICompatTransforms && contentType.includes('application/json') && body.length > 0) {
    try {
      const parsed = flattenMessages(JSON.parse(body.toString('utf8')) as ChatCompletionBody)
      body = Buffer.from(JSON.stringify(parsed))
      const msgs = Array.isArray(parsed.messages) ? parsed.messages.length : 0
      options.logger.trace(`-> ${req.method ?? '?'} ${req.url ?? '?'} msgs=${msgs} bytes=${body.length}`)
    } catch {
      // forward unchanged
    }
  }

  await options.whenUpstream
  const upstream = options.getUpstream()
  if (upstream === undefined) {
    writeProxyError(res, 503, 'qvac serve is not available')
    return
  }

  if (isInferenceRequest(req)) {
    await runInference(() => forwardToUpstream(req, res, body, reqStart, upstream, options))
    return
  }

  await forwardToUpstream(req, res, body, reqStart, upstream, options)
}

export function startOpenAICompatibleProxy (options: ProxyOptions): Promise<StartedOpenAICompatibleProxy> {
  const runInference = createSerializedRunner()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.on('error', () => {})
    req.on('error', () => {})
    const reqStart = Date.now()
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void handleRequest(req, res, Buffer.concat(chunks), reqStart, options, runInference).catch((err: unknown) => {
        options.logger.trace(`proxy request error: ${String(err)}`)
        writeProxyError(res, 500, 'qvac serve proxy internal error')
      })
    })
  })
  server.on('error', (err) => options.logger.trace(`proxy server error: ${String(err)}`))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => {
          server.close((err) => {
            if (err === undefined) res()
            else rej(err)
          })
        })
      })
    })
  })
}
