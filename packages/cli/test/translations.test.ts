import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { ServerResponse } from 'node:http'
import { handleTranslations } from '../src/serve/adapters/openai/routes/translations.js'
import { createModelRegistry } from '../src/serve/core/model-registry.js'
import type { ServeConfig, ResolvedModelEntry } from '../src/serve/core/model-registry.js'
import type { Logger } from '../src/logger.js'

function buildMultipart (
  boundary: string,
  fields: Record<string, string>,
  file?: { fieldName: string; fileName: string; data: Buffer }
): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ))
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n'
    ))
    parts.push(file.data)
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

function makeMultipartRequest (body: Buffer, boundary: string): IncomingMessage {
  const stream = new PassThrough()
  const req = stream as unknown as IncomingMessage
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`
  }
  req.method = 'POST'
  req.url = '/v1/audio/translations'
  queueMicrotask(() => {
    stream.end(body)
  })
  return req
}

function createMockRes (): ServerResponse & { getPayload: () => string; getStatus: () => number } {
  let payload = ''
  let status = 0
  const res = {
    statusCode: 200,
    headersSent: false,
    writeHead (code: number) {
      this.statusCode = code
      status = code
    },
    end (data?: string | Buffer) {
      if (typeof data === 'string') payload = data
      else if (Buffer.isBuffer(data)) payload = data.toString('utf8')
      else payload = ''
    },
    getPayload () {
      return payload
    },
    getStatus () {
      return status
    }
  }
  return res as unknown as ServerResponse & { getPayload: () => string; getStatus: () => number }
}

function makeLogger (): Logger & { warns: string[] } {
  const warns: string[] = []
  return {
    error () {},
    warn (m: string) {
      warns.push(m)
    },
    info () {},
    debug () {},
    warns
  }
}

function resolvedEntry (overrides: Partial<ResolvedModelEntry>): ResolvedModelEntry {
  return {
    alias: 'en',
    src: 'hyper://example/model',
    sdkType: 'whispercpp-transcription',
    endpointCategory: 'audio-translation',
    isDefault: false,
    preload: false,
    config: {},
    ...overrides
  }
}

describe('handleTranslations', () => {
  const boundary = 'qvac-test'

  it('rejects non-multipart Content-Type', async () => {
    const stream = new PassThrough()
    const req = stream as unknown as IncomingMessage
    req.headers = { 'content-type': 'application/json' }
    req.method = 'POST'
    queueMicrotask(() => stream.end('{}'))
    const res = createMockRes()
    const registry = createModelRegistry()
    const serveConfig: ServeConfig = { models: new Map(), defaults: new Map() }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 400)
    const body = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(body.error.code, 'invalid_content_type')
  })

  it('rejects missing file field', async () => {
    const body = buildMultipart(boundary, { model: 'en' })
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    const serveConfig: ServeConfig = {
      models: new Map([['en', resolvedEntry({})]]),
      defaults: new Map()
    }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 400)
    const j = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(j.error.code, 'missing_file')
  })

  it('rejects missing model field', async () => {
    const body = buildMultipart(boundary, {}, { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(4) })
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    const serveConfig: ServeConfig = { models: new Map(), defaults: new Map() }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 400)
    const j = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(j.error.code, 'missing_model')
  })

  it('returns 404 for unknown model', async () => {
    const body = buildMultipart(boundary, { model: 'missing' }, { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(1) })
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    const serveConfig: ServeConfig = { models: new Map(), defaults: new Map() }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 404)
    const j = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(j.error.code, 'model_not_found')
  })

  it('returns 400 when model is not audio-translation category', async () => {
    const body = buildMultipart(boundary, { model: 'tr' }, { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(1) })
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    const tr: ResolvedModelEntry = {
      alias: 'tr',
      src: 'hyper://x',
      sdkType: 'whispercpp-transcription',
      endpointCategory: 'transcription',
      isDefault: false,
      preload: false,
      config: {}
    }
    const serveConfig: ServeConfig = {
      models: new Map([['tr', tr]]),
      defaults: new Map()
    }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 400)
    const j = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(j.error.code, 'invalid_model_type')
  })

  it('returns 503 when model is not ready', async () => {
    const body = buildMultipart(boundary, { model: 'en' }, { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(1) })
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    registry.register('en', {
      src: 'hyper://x',
      sdkType: 'whispercpp-transcription',
      endpointCategory: 'audio-translation',
      config: {}
    })
    const serveConfig: ServeConfig = {
      models: new Map([['en', resolvedEntry({})]]),
      defaults: new Map()
    }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 503)
    const j = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(j.error.code, 'model_not_ready')
  })

  it('rejects language field', async () => {
    const body = buildMultipart(
      boundary,
      { model: 'en', language: 'es' },
      { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(1) }
    )
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    registry.register('en', {
      src: 'hyper://x',
      sdkType: 'whispercpp-transcription',
      endpointCategory: 'audio-translation',
      config: {}
    })
    registry.setReady('en', 'mid')
    const serveConfig: ServeConfig = {
      models: new Map([['en', resolvedEntry({})]]),
      defaults: new Map()
    }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 400)
    const j = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(j.error.code, 'unsupported_param')
  })

  it('rejects unsupported response_format srt', async () => {
    const body = buildMultipart(
      boundary,
      { model: 'en', response_format: 'srt' },
      { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(1) }
    )
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    registry.register('en', {
      src: 'hyper://x',
      sdkType: 'whispercpp-transcription',
      endpointCategory: 'audio-translation',
      config: {}
    })
    registry.setReady('en', 'mid')
    const serveConfig: ServeConfig = {
      models: new Map([['en', resolvedEntry({})]]),
      defaults: new Map()
    }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 400)
    const j = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(j.error.code, 'unsupported_response_format')
  })

  it('rejects invalid response_format', async () => {
    const body = buildMultipart(
      boundary,
      { model: 'en', response_format: 'xml' },
      { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(1) }
    )
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    registry.register('en', {
      src: 'hyper://x',
      sdkType: 'whispercpp-transcription',
      endpointCategory: 'audio-translation',
      config: {}
    })
    registry.setReady('en', 'mid')
    const serveConfig: ServeConfig = {
      models: new Map([['en', resolvedEntry({})]]),
      defaults: new Map()
    }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger()
    })
    assert.equal(res.getStatus(), 400)
    const j = JSON.parse(res.getPayload()) as { error: { code: string } }
    assert.equal(j.error.code, 'invalid_response_format')
  })

  it('warns on temperature but still succeeds with override', async () => {
    const body = buildMultipart(
      boundary,
      { model: 'en', temperature: '0.7' },
      { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(1) }
    )
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    registry.register('en', {
      src: 'hyper://x',
      sdkType: 'whispercpp-transcription',
      endpointCategory: 'audio-translation',
      config: {}
    })
    registry.setReady('en', 'mid')
    const serveConfig: ServeConfig = {
      models: new Map([['en', resolvedEntry({})]]),
      defaults: new Map()
    }
    const logger = makeLogger()
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger,
      transcribeOverride: async () => ({ requestId: 'rid-test', result: Promise.resolve('hello') })
    })
    assert.equal(res.getStatus(), 200)
    const j = JSON.parse(res.getPayload()) as { text: string }
    assert.equal(j.text, 'hello')
    assert.ok((logger as Logger & { warns: string[] }).warns.some((w) => w.includes('temperature')))
  })

  it('returns JSON text on success', async () => {
    const body = buildMultipart(boundary, { model: 'en' }, { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(2) })
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    registry.register('en', {
      src: 'hyper://x',
      sdkType: 'whispercpp-transcription',
      endpointCategory: 'audio-translation',
      config: {}
    })
    registry.setReady('en', 'mid')
    const serveConfig: ServeConfig = {
      models: new Map([['en', resolvedEntry({})]]),
      defaults: new Map()
    }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger(),
      transcribeOverride: async () => ({ requestId: 'rid-test', result: Promise.resolve('out') })
    })
    assert.equal(res.getStatus(), 200)
    const j = JSON.parse(res.getPayload()) as { text: string }
    assert.equal(j.text, 'out')
  })

  it('returns plain text when response_format is text', async () => {
    const body = buildMultipart(
      boundary,
      { model: 'en', response_format: 'text' },
      { fieldName: 'file', fileName: 'a.wav', data: Buffer.alloc(1) }
    )
    const req = makeMultipartRequest(body, boundary)
    const res = createMockRes()
    const registry = createModelRegistry()
    registry.register('en', {
      src: 'hyper://x',
      sdkType: 'whispercpp-transcription',
      endpointCategory: 'audio-translation',
      config: {}
    })
    registry.setReady('en', 'mid')
    const serveConfig: ServeConfig = {
      models: new Map([['en', resolvedEntry({})]]),
      defaults: new Map()
    }
    await handleTranslations(req, res, {
      registry,
      serveConfig,
      logger: makeLogger(),
      transcribeOverride: async () => ({ requestId: 'rid-test', result: Promise.resolve('plain') })
    })
    assert.equal(res.getStatus(), 200)
    assert.equal(res.getPayload(), 'plain')
  })
})
