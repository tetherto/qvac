import type { IncomingMessage, ServerResponse } from 'node:http'

export function handleCors (req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
  }
}

export function readBody (req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) as Record<string, unknown> : {})
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reject(new Error(`Invalid JSON body: ${message}`))
      }
    })
    req.on('error', reject)
  })
}

export function sendJson (res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return

  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

export function sendError (res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    sendSSE(res, { error: { message, type: 'server_error', code } })
    endSSE(res)
    return
  }

  sendJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code
    }
  })
}

export function initSSE (res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
}

export function sendSSE (res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export function endSSE (res: ServerResponse): void {
  res.write('data: [DONE]\n\n')
  res.end()
}

export function sendText (res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}
