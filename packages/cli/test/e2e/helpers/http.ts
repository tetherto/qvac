import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'

export type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>

export const JSON_HEADERS = { 'content-type': 'application/json' }

// Assert an OpenAI-style error envelope: { error: { code, message } }.
export function assertError(res: InjectResponse, expectedCode: string): void {
  const body = res.json() as { error?: { code?: string; message?: unknown } }
  assert.equal(
    body?.error?.code,
    expectedCode,
    `expected error.code=${expectedCode}, got body=${res.payload}`
  )
  assert.equal(typeof body?.error?.message, 'string', 'error.message should be a string')
}

// Assert the HTTP status and the OpenAI error code together.
export function assertStatusAndError(
  res: InjectResponse,
  status: number,
  expectedCode: string
): void {
  assert.equal(
    res.statusCode,
    status,
    `expected status ${status}, got ${res.statusCode}: ${res.payload}`
  )
  assertError(res, expectedCode)
}

export interface MultipartField {
  name: string
  value?: string
  filename?: string
  contentType?: string
  data?: Buffer
}

// Build a multipart/form-data body for app.inject.
// Returns the payload buffer and the matching content-type header.
export function multipart(fields: MultipartField[]): {
  payload: Buffer
  headers: Record<string, string>
} {
  const boundary = '----qvacE2EFormBoundary'
  const parts: Buffer[] = []
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`
    if (f.filename !== undefined) head += `; filename="${f.filename}"`
    head += '\r\n'
    if (f.contentType !== undefined) head += `Content-Type: ${f.contentType}\r\n`
    head += '\r\n'
    parts.push(Buffer.from(head))
    parts.push(f.data ?? Buffer.from(f.value ?? ''))
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  }
}

export interface SSEEvent {
  event?: string
  data: unknown
}

// Parse an SSE response body (as captured by app.inject) into events.
// Handles `event:` + `data:` lines; the `[DONE]` sentinel is kept as a
// literal string so callers can assert on stream termination.
export function collectSSE(payload: string): SSEEvent[] {
  const events: SSEEvent[] = []
  for (const frame of payload.split('\n\n')) {
    const trimmed = frame.trim()
    if (trimmed.length === 0) continue
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
    }
    if (dataLines.length === 0) continue
    const raw = dataLines.join('\n')
    const base = event !== undefined ? { event } : {}
    events.push({ ...base, data: raw === '[DONE]' ? '[DONE]' : JSON.parse(raw) })
  }
  return events
}
