import type { ServerResponse } from 'node:http'
import type { FastifyReply } from 'fastify'

export function initSSE(reply: FastifyReply, extraHeaders?: Record<string, string | number>): void {
  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...extraHeaders
  })
}

export function sendSSE(raw: ServerResponse, data: unknown): void {
  // Escape `<`/`>` so EventSource consumers cannot interpret payloads as HTML.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  raw.write(`data: ${json}\n\n`)
}

export interface EndSSEOptions {
  sentinel?: boolean
}

export function endSSE(raw: ServerResponse, opts?: EndSSEOptions): void {
  if (opts?.sentinel !== false) {
    raw.write('data: [DONE]\n\n')
  }
  raw.end()
}
