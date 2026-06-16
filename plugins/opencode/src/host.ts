// Managed `qvac serve` host, spawned by the OpenCode plugin (src/index.ts).
//
// It runs in a real node/bun runtime (NOT OpenCode's compiled binary) so the
// provider's managed mode can spawn its detached supervisor — OpenCode's
// `process.execPath` is the editor binary, which managed mode can't launch.
//
// Startup is deliberately two-phase so the plugin never blocks OpenCode on a
// cold model download:
//   1. Start the proxy on an auto-allocated port and immediately print
//      `QVAC_LISTENING {baseURL,modelId,modelName}`. The plugin reads only this
//      line, injects the provider, and lets OpenCode proceed.
//   2. Bring the managed serve up in the background and attach it as the proxy
//      upstream. Requests that arrive before the serve is healthy wait on it,
//      so the first turn looks like a slow cold model — not a startup failure.
//
// On SIGTERM/SIGINT it closes the provider (deregistering this session's
// consumer). A hard kill is handled by the provider's `closeOnParentExit`
// parent-pid watch and the runner's idle reaper, so the shared serve is never
// orphaned.
import { appendFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'

import { createQvac } from '@qvac/ai-sdk-provider'
import { findCatalogEntry } from '@qvac/ai-sdk-provider/models'

import {
  flattenMessages,
  makeThinkSplitter,
  transformSSEChunk,
  type ChatCompletionBody,
  type SSEChunk
} from './shim.js'

const REQUESTED_MODEL = process.env['QVAC_MODEL'] ?? 'qwen3.5-9b'
const CATALOG_ENTRY = findCatalogEntry(REQUESTED_MODEL)
// Serve alias + the id OpenCode shows. A known catalog id (or its constant)
// normalizes to the friendly id; anything else passes through verbatim.
const MODEL_ID = CATALOG_ENTRY?.id ?? REQUESTED_MODEL
const MODEL_NAME = CATALOG_ENTRY?.name ?? REQUESTED_MODEL
const CTX_SIZE = Number(process.env['QVAC_CTX_SIZE'] ?? 32768)
const REASONING_BUDGET = Number(process.env['QVAC_REASONING_BUDGET'] ?? -1)
const TOOLS = process.env['QVAC_TOOLS'] !== 'false'
const COMPAT_TRANSFORMS = process.env['QVAC_SHIM'] !== 'false'
const READY_TIMEOUT_MS = Number(process.env['QVAC_READY_TIMEOUT_MS'] ?? 1_800_000)
const DEBUG = process.env['QVAC_DEBUG'] === 'true' || process.env['QVAC_DEBUG'] === '1'
const LOG_FILE = process.env['QVAC_HOST_LOG']
let inferenceTail: Promise<void> = Promise.resolve()

function toFile (msg: string): void {
  if (LOG_FILE === undefined) return
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // best effort
  }
}

// Startup milestones and the machine-readable readiness lines go to stdout (the
// plugin parses them); everything is also mirrored to an optional log file.
function log (msg: string): void {
  process.stdout.write(`${msg}\n`)
  toFile(msg)
}

// Per-request traces are noisy, so file-only unless QVAC_DEBUG surfaces them.
function trace (msg: string): void {
  if (DEBUG) process.stdout.write(`${msg}\n`)
  toFile(msg)
}

// A streaming proxy must never crash the host: a slow or aborted upstream
// stream emits 'error' events that, unhandled, would take the whole process
// down (the failure mode that killed earlier prototypes via UND_ERR_BODY_TIMEOUT
// bubbling up). Per-request handlers clean up; these are the final backstop.
process.on('uncaughtException', (err) => trace(`uncaughtException (ignored): ${String(err)}`))
process.on('unhandledRejection', (err) => trace(`unhandledRejection (ignored): ${String(err)}`))

// Resolves to the live serve origin (host:port) once the managed serve is
// healthy. Reads the provider getter every call so a crash-recovery respawn on
// a new port is followed transparently.
interface Upstream {
  hostname: string
  port: string
}

function originOf (baseURL: string): Upstream {
  const u = new URL(baseURL)
  return { hostname: u.hostname, port: u.port }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T> (): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
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

async function runSerializedInference (work: () => Promise<void>): Promise<void> {
  const previous = inferenceTail
  let release!: () => void
  inferenceTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous.catch(() => {})
  try {
    await work()
  } finally {
    release()
  }
}

function emitSSELine (line: string, split: ReturnType<typeof makeThinkSplitter>, res: ServerResponse): void {
  if (line.startsWith('data:')) {
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
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

// Forward an upstream response back to the client. With the shim on, an SSE
// body is run through the `<think>` splitter; otherwise (and for all non-SSE
// bodies) it is piped through untouched.
function pipeResponse (upstreamRes: IncomingMessage, res: ServerResponse, reqStart: number): void {
  upstreamRes.on('error', () => res.destroy())
  const outHeaders: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    if (value !== undefined && key !== 'content-encoding') outHeaders[key] = value
  }
  res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)

  const isSSE = (upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')
  if (!COMPAT_TRANSFORMS || !isSSE) {
    upstreamRes.on('end', () => trace(`done total=${((Date.now() - reqStart) / 1000).toFixed(1)}s`))
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
    res.end()
    trace(`done total=${((Date.now() - reqStart) / 1000).toFixed(1)}s`)
  })
}

async function forwardToUpstream (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  reqStart: number,
  upstream: Upstream
): Promise<void> {
  await new Promise<void>((resolve) => {
    const proxyReq = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: buildForwardHeaders(req, body.length)
      },
      (proxyRes) => {
        trace(`<- ${proxyRes.statusCode ?? '?'} headers=${((Date.now() - reqStart) / 1000).toFixed(1)}s`)
        proxyRes.on('end', resolve)
        proxyRes.on('close', resolve)
        proxyRes.on('error', resolve)
        pipeResponse(proxyRes, res, reqStart)
      }
    )
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `qvac serve proxy error: ${String(err)}` } }))
      } else {
        res.destroy()
      }
      resolve()
    })
    res.on('close', () => {
      proxyReq.destroy()
      resolve()
    })
    if (body.length > 0) proxyReq.write(body)
    proxyReq.end()
  })
}

function startProxy (getUpstream: () => Upstream | undefined, whenUpstream: Promise<void>): Promise<number> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.on('error', () => {})
    req.on('error', () => {})
    const reqStart = Date.now()
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void handleRequest(req, res, Buffer.concat(chunks), reqStart, getUpstream, whenUpstream)
    })
  })
  server.on('error', (err) => trace(`proxy server error: ${String(err)}`))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
}

async function handleRequest (
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  reqStart: number,
  getUpstream: () => Upstream | undefined,
  whenUpstream: Promise<void>
): Promise<void> {
  let body = rawBody
  const contentType = req.headers['content-type'] ?? ''
  if (COMPAT_TRANSFORMS && contentType.includes('application/json') && body.length > 0) {
    try {
      const parsed = flattenMessages(JSON.parse(body.toString('utf8')) as ChatCompletionBody)
      body = Buffer.from(JSON.stringify(parsed))
      const msgs = Array.isArray(parsed.messages) ? parsed.messages.length : 0
      trace(`-> ${req.method ?? '?'} ${req.url ?? '?'} msgs=${msgs} bytes=${body.length}`)
    } catch {
      // not JSON we understand — forward untouched
    }
  }

  // Wait for the serve to come up (cold download included) before forwarding.
  await whenUpstream
  const upstream = getUpstream()
  if (upstream === undefined) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'qvac serve is not available' } }))
    return
  }

  if (isInferenceRequest(req)) {
    await runSerializedInference(() => forwardToUpstream(req, res, body, reqStart, upstream))
    return
  }

  await forwardToUpstream(req, res, body, reqStart, upstream)
}

async function main (): Promise<void> {
  const t0 = Date.now()
  const live: { upstream: Upstream | undefined } = { upstream: undefined }
  const upstreamReady = deferred<void>()

  const proxyPort = await startProxy(() => live.upstream, upstreamReady.promise)
  const proxyBaseURL = `http://127.0.0.1:${proxyPort}/v1`
  // Phase 1 done: the plugin can configure OpenCode now, before the serve boots.
  log(`QVAC_LISTENING ${JSON.stringify({ baseURL: proxyBaseURL, modelId: MODEL_ID, modelName: MODEL_NAME })}`)

  log(`starting managed serve for ${MODEL_ID} (ctx_size=${CTX_SIZE}, reasoning_budget=${REASONING_BUDGET}, tools=${TOOLS})…`)
  log('first run downloads the model — this can take a while.')

  const qvac = await createQvac({
    mode: 'managed',
    // Share one serve across OpenCode windows: any host whose model + config
    // match attaches to the same registry-owned serve instead of reloading the
    // model. The detached runner keeps it warm and reaps it after the last
    // session leaves.
    reuse: true,
    // Die with OpenCode: on a hard quit none of our handlers run and we would be
    // reparented to init, leaving our consumer marker behind so the shared serve
    // never reaches zero consumers. The provider watches our parent pid and, when
    // OpenCode exits, removes just this session's marker — the shared serve lives
    // on for others.
    closeOnParentExit: true,
    models: [
      {
        name: MODEL_ID,
        config: { ctx_size: CTX_SIZE, reasoning_budget: REASONING_BUDGET, tools: TOOLS },
        default: true
      }
    ],
    serveStartTimeout: READY_TIMEOUT_MS
  })

  // The provider's baseURL getter tracks the live serve across respawns, so read
  // it per request rather than capturing the origin once.
  live.upstream = originOf(qvac.baseURL)
  upstreamReady.resolve()
  log(`healthy in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  log(`QVAC_READY ${JSON.stringify({ baseURL: proxyBaseURL, servePort: qvac.port, pid: qvac.pid, modelId: MODEL_ID })}`)

  let stopping = false
  async function stop (reason: string): Promise<void> {
    if (stopping) return
    stopping = true
    trace(`shutting down: ${reason}`)
    await qvac.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))

  // Keep the live serve origin pointed at the provider after a recovery respawn.
  const retarget = setInterval(() => {
    try {
      live.upstream = originOf(qvac.baseURL)
    } catch {
      // provider not reporting a URL right now — keep the last known origin
    }
  }, 2000)
  retarget.unref()

  await new Promise<void>(() => {})
}

void main()
