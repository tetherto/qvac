import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { buildServer } from '@/serve/index'
import { binaryInput, resolveBinaryInput } from '@/serve/lib/binary-input'
import { multipartToBodyOptional } from '@/serve/lib/multipart'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// No extension is mounted, so the route below proves multipart parsing comes
// from core rather than from the openai extension.
async function buildEchoServer(): Promise<FastifyInstance> {
  const app = await buildServer({
    projectRoot: tmpdir(),
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    extensions: []
  })
  // lunte-disable-next-line require-await
  await app.register(async (scope) => {
    scope.withTypeProvider<ZodTypeProvider>().post(
      '/echo',
      {
        schema: { body: z.object({ image: binaryInput('Image.') }) },
        preValidation: multipartToBodyOptional
      },
      // lunte-disable-next-line require-await
      async (req) => {
        const input = resolveBinaryInput(req, 'image', req.body.image)
        return {
          base64: input.bytes.toString('base64'),
          mediaType: input.mediaType,
          fileName: input.fileName
        }
      }
    )
  })
  await app.ready()
  return app
}

async function multipart(form: FormData): Promise<{ payload: Buffer; contentType: string }> {
  const request = new Request('http://localhost/', { method: 'POST', body: form })
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get('content-type')!
  }
}

describe('binary input', () => {
  let app: FastifyInstance

  before(async () => {
    app = await buildEchoServer()
  })
  after(async () => {
    await app.close()
  })

  async function postJson(image: unknown) {
    return await app.inject({ method: 'POST', url: '/echo', payload: { image } })
  }

  it('reads a multipart upload with its declared type and name', async () => {
    const form = new FormData()
    form.append('image', new Blob([PNG], { type: 'image/png' }), 'cat.png')
    const { payload, contentType } = await multipart(form)

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload,
      headers: { 'content-type': contentType }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      base64: PNG.toString('base64'),
      mediaType: 'image/png',
      fileName: 'cat.png'
    })
  })

  it('treats an octet-stream upload as untyped', async () => {
    const form = new FormData()
    form.append('image', new Blob([PNG]), 'blob')
    const { payload, contentType } = await multipart(form)

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload,
      headers: { 'content-type': contentType }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().mediaType, null)
  })

  it('accepts a data URL sent as a multipart text part', async () => {
    const form = new FormData()
    form.append('image', `data:image/png;base64,${PNG.toString('base64')}`)
    const { payload, contentType } = await multipart(form)

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload,
      headers: { 'content-type': contentType }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().base64, PNG.toString('base64'))
  })

  it('decodes a base64 data URL', async () => {
    const res = await postJson(`data:IMAGE/PNG;base64,${PNG.toString('base64')}`)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      base64: PNG.toString('base64'),
      mediaType: 'image/png',
      fileName: null
    })
  })

  it('resolves the id of an uploaded file', async () => {
    const id = app.qvac.files.put({
      data: PNG,
      fileName: 'stored.png',
      purpose: 'user_data',
      contentType: 'image/png'
    })

    const res = await postJson(id)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      base64: PNG.toString('base64'),
      mediaType: 'image/png',
      fileName: 'stored.png'
    })
  })

  for (const [name, image, code] of [
    ['an unknown file id', 'file-missing', 'file_not_found'],
    ['a data URL that is not base64-encoded', 'data:text/plain,hello', 'invalid_data_url'],
    ['a data URL without a comma', 'data:image/png;base64', 'invalid_data_url'],
    ['a data URL with invalid base64', 'data:image/png;base64,@@@', 'invalid_data_url'],
    ['a data URL with no bytes', 'data:image/png;base64,', 'empty_input']
  ] as const) {
    it(`rejects ${name}`, async () => {
      const res = await postJson(image)

      assert.equal(res.statusCode, 400)
      const { error } = res.json() as { error: { code: string; message: string } }
      assert.equal(error.code, code)
      assert.match(error.message, /^image: /)
    })
  }

  it('rejects an empty multipart upload', async () => {
    const form = new FormData()
    form.append('image', new Blob([]), 'empty.png')
    const { payload, contentType } = await multipart(form)

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload,
      headers: { 'content-type': contentType }
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.code, 'empty_input')
  })
})
