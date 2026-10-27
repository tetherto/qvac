import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { request, get } from 'node:http'
import { Readable } from 'node:stream'
import { z } from 'zod'
import createHttpServer from '@/lib/http'
import { multipartParts, type MultipartPart } from '@/lib/http/multipart'

const boundary = 'qvac-transport-boundary'
const contentType = `multipart/form-data; boundary="${boundary}"`
function multipart(values: Array<{ name: string; data: string | Buffer; filename?: string }>) {
  const chunks: Buffer[] = []
  for (const value of values) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${value.name}"${value.filename === undefined ? '' : `; filename="${value.filename}"`}\r\n\r\n`
      )
    )
    chunks.push(Buffer.isBuffer(value.data) ? value.data : Buffer.from(value.data))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}
async function parts(body: Buffer, limits: Parameters<typeof multipartParts>[2] = {}) {
  const result: MultipartPart[] = []
  for await (const part of multipartParts(body, contentType, limits)) result.push(part)
  return result
}

describe('HTTP multipart transport', () => {
  it('preserves binary bytes, boundary prefixes and repeated file order', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0, 255, 128]),
      Buffer.from(`\r\n--${boundary}not-a-delimiter\r\n--${boundary}--junk\r\n`),
      Buffer.from([254, 0])
    ])
    const result = await parts(
      multipart([
        { name: 'model', data: 'fixture' },
        { name: 'image[]', filename: 'first.bin', data: bytes },
        { name: 'image[]', filename: 'second.bin', data: 'second' }
      ])
    )
    assert.deepEqual(result[0], { type: 'field', fieldname: 'model', value: 'fixture' })
    const files = result.filter((part) => part.type === 'file')
    assert.deepEqual(
      files.map((part) => part.filename),
      ['first.bin', 'second.bin']
    )
    assert.deepEqual(await files[0]!.toBuffer(), bytes)
    assert.equal((await files[1]!.toBuffer()).toString(), 'second')
  })

  it('rejects a truncated body instead of returning a partial uploaded file', async () => {
    const body = multipart([{ name: 'file', filename: 'file.bin', data: 'data' }])
    await assert.rejects(
      parts(body.subarray(0, body.length - boundary.length - 8)),
      /incomplete|boundary/i
    )
  })

  it('enforces file, field, header and count limits', async () => {
    const file = { name: 'file', filename: 'file.bin', data: '12345' }
    await assert.rejects(parts(multipart([file]), { fileSize: 4 }), /large|limit/i)
    await assert.rejects(parts(multipart([file, file]), { files: 1 }), /many|limit/i)
    await assert.rejects(
      parts(multipart([{ name: 'field', data: '12345' }]), { fieldSize: 4 }),
      /large|limit/i
    )
    await assert.rejects(
      parts(
        multipart([
          { name: 'a', data: '1' },
          { name: 'b', data: '2' }
        ]),
        { fields: 1 }
      ),
      /many|limit/i
    )
    await assert.rejects(parts(multipart([file]), { headerSize: 8 }), /large|limit/i)
  })
})

describe('HTTP transport lifecycle', () => {
  it('isolates child hooks while inheriting root hooks', async (t) => {
    const app = createHttpServer()
    t.after(() => app.close())
    const seen: string[] = []
    app.addHook('onRequest', (_req, _reply, done) => {
      seen.push('root')
      done()
    })
    await app.register((child) => {
      child.addHook('onRequest', (_req, _reply, done) => {
        seen.push('child')
        done()
      })
      child.get('/child', () => ({ scope: 'child' }))
    })
    app.get('/root', () => ({ scope: 'root' }))
    assert.equal((await app.inject('/child')).statusCode, 200)
    assert.deepEqual(seen.splice(0), ['root', 'child'])
    assert.equal((await app.inject('/root')).statusCode, 200)
    assert.deepEqual(seen, ['root'])
  })

  it('prioritizes static routes before parameters and wildcards independent of registration order', async (t) => {
    const app = createHttpServer()
    t.after(() => app.close())
    app.get('/files/*', () => ({ route: 'wildcard' }))
    app.get('/files/:id', (req) => ({ route: 'parameter', id: req.params['id'] }))
    app.get('/files/catalog', () => ({ route: 'static' }))
    assert.deepEqual((await app.inject('/files/catalog')).json(), { route: 'static' })
    assert.deepEqual((await app.inject('/files/one')).json(), { route: 'parameter', id: 'one' })
    assert.deepEqual((await app.inject('/files/one/content')).json(), { route: 'wildcard' })
  })

  it('rejects malformed parameter encoding with a client error', async (t) => {
    const app = createHttpServer()
    t.after(() => app.close())
    let handled = false
    app.get('/files/:id', () => {
      handled = true
      return {}
    })
    assert.equal((await app.inject('/files/%ZZ')).statusCode, 400)
    assert.equal(handled, false)
  })

  it('validates declared request headers before invoking the handler', async (t) => {
    const app = createHttpServer()
    t.after(() => app.close())
    let calls = 0
    app.get(
      '/headers',
      { schema: { headers: z.object({ 'x-required': z.literal('accepted') }) } },
      () => {
        calls++
        return { ok: true }
      }
    )
    assert.equal((await app.inject('/headers')).statusCode, 400)
    assert.equal(
      (await app.inject({ url: '/headers', headers: { 'x-required': 'wrong' } })).statusCode,
      400
    )
    assert.equal(calls, 0)
    assert.equal(
      (await app.inject({ url: '/headers', headers: { 'x-required': 'accepted' } })).statusCode,
      200
    )
    assert.equal(calls, 1)
  })

  it(
    'destroys a streamed response source when its client disconnects',
    { timeout: 5000 },
    async (t) => {
      const app = createHttpServer()
      t.after(() => app.close())
      let started = false
      const source = new Readable({
        read() {
          if (!started) {
            started = true
            this.push('started')
          }
        }
      })
      t.after(() => source.destroy())
      const sourceClosed = new Promise<void>((resolve) => source.once('close', resolve))
      app.get('/stream', (_req, reply) => reply.send(source))
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await new Promise<void>((resolve, reject) => {
        const req = get(new URL('/stream', address), (res) => {
          res.once('data', () => {
            res.destroy()
            resolve()
          })
        })
        req.on('error', reject)
      })
      await sourceClosed
      assert.equal(source.destroyed, true)
    }
  )

  it('stops the lifecycle after an onRequest response', async (t) => {
    const app = createHttpServer()
    t.after(() => app.close())
    let handled = false
    app.addHook('onRequest', (_req, reply, done) => {
      reply.code(401).send({ error: 'denied' })
      done()
    })
    app.post('/protected', { schema: { body: z.object({ required: z.string() }) } }, () => {
      handled = true
      return {}
    })
    const response = await app.inject({
      method: 'POST',
      url: '/protected',
      payload: '{',
      headers: { 'content-type': 'application/json' }
    })
    assert.equal(response.statusCode, 401)
    assert.equal(handled, false)
  })

  it('validates after preValidation and serializes the declared response schema', async (t) => {
    const app = createHttpServer()
    t.after(() => app.close())
    app.post(
      '/validated',
      {
        preValidation(req, _reply, done) {
          req.body = { count: '7' }
          done()
        },
        schema: {
          body: z.object({ count: z.coerce.number().int() }),
          response: { 200: z.object({ count: z.number() }) }
        }
      },
      (req) => ({ count: req.body.count, privateValue: 'must not escape' })
    )
    const response = await app.inject({ method: 'POST', url: '/validated', payload: {} })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { count: 7 })
  })

  it('routes invalid responses through the error handler before sending headers', async (t) => {
    const app = createHttpServer()
    t.after(() => app.close())
    app.setErrorHandler((error, _req, reply) => reply.code(500).send({ code: error.code }))
    app.get('/invalid', { schema: { response: { 200: z.object({ count: z.number() }) } } }, () => ({
      count: 'secret-invalid-value'
    }))
    const response = await app.inject('/invalid')
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), { code: 'HTTP_RESPONSE_SERIALIZATION' })
    assert.doesNotMatch(response.payload, /secret-invalid-value/)
  })

  it(
    'enforces the total limit on chunked network requests without Content-Length',
    { timeout: 5000 },
    async (t) => {
      const app = createHttpServer({ bodyLimit: 8 })
      t.after(() => app.close())
      let handled = false
      app.post('/body', () => {
        handled = true
        return {}
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          new URL('/body', address),
          { method: 'POST', headers: { 'content-type': 'application/json' } },
          (res) => {
            res.resume()
            res.once('end', () => resolve(res.statusCode))
          }
        )
        req.on('error', reject)
        req.write('{"value":')
        req.end('"too large"}')
      })
      assert.equal(status, 413)
      assert.equal(handled, false)
    }
  )

  it(
    'exposes client disconnect on the raw reply and closes exactly once',
    { timeout: 5000 },
    async () => {
      const app = createHttpServer()
      let closed = 0
      let disconnected!: () => void
      const disconnect = new Promise<void>((resolve) => {
        disconnected = resolve
      })
      app.addHook('onClose', (_server, done) => {
        closed++
        done()
      })
      app.get('/events', (_req, reply) => {
        reply.raw.once('close', disconnected)
        reply.hijack()
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
        reply.raw.write('data: started\n\n')
      })
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        await new Promise<void>((resolve, reject) => {
          const req = get(new URL('/events', address), (res) => {
            res.once('data', () => {
              res.destroy()
              resolve()
            })
          })
          req.on('error', reject)
        })
        await disconnect
        await app.close()
        await app.close()
        assert.equal(closed, 1)
      } finally {
        await app.close()
      }
    }
  )
})
