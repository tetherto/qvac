import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '@/lib/api/index'
import { MODELLESS_CONFIG, writeConfigDir } from '../helpers/config.js'

interface OpenApiDocument {
  openapi: string
  security?: Array<{ bearerAuth: unknown[] }>
  paths: Record<
    string,
    {
      get?: { parameters?: Array<{ in: string; name: string; required?: boolean }> }
      post?: {
        requestBody?: {
          content: Record<
            string,
            { schema: { properties?: Record<string, { type?: string; format?: string }> } }
          >
        }
      }
    }
  >
}

describe('self-contained API documentation', () => {
  it('serves public docs and its spec while retaining API authentication and Host checks', async (t) => {
    const projectRoot = await writeConfigDir(t, MODELLESS_CONFIG)
    const app = await buildServer({
      projectRoot,
      port: 11434,
      host: '127.0.0.1',
      docs: true,
      apiKey: 'docs-test-secret-key',
      quiet: true
    })
    t.after(() => app.close())
    for (const url of ['/docs', '/docs/']) {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 200)
      assert.match(String(response.headers['content-type']), /text\/html/)
      assert.match(response.payload, /\/openapi\.json/)
      assert.doesNotMatch(response.payload, /<(?:script|link)\b[^>]*(?:src|href)=["']https?:/i)
      assert.doesNotMatch(response.payload, /docs-test-secret-key/)
      const script = /<script type="module">([\s\S]*?)<\/script>/.exec(response.payload)
      assert.ok(script, 'interactive explorer script must be present')
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        body: string
      ) => unknown
      assert.doesNotThrow(() => new AsyncFunction(script[1]!))
    }
    const spec = await app.inject('/docs/json')
    assert.equal(spec.statusCode, 200)
    assert.deepEqual(spec.json(), (await app.inject('/openapi.json')).json())
    assert.equal((await app.inject('/v1/models')).statusCode, 401)
    assert.equal(
      (await app.inject({ url: '/docs', headers: { host: 'untrusted.example' } })).statusCode,
      403
    )
  })

  it('describes path parameters and multipart uploads in the OpenAPI document', async (t) => {
    const projectRoot = await writeConfigDir(t, MODELLESS_CONFIG)
    const app = await buildServer({
      projectRoot,
      port: 11434,
      host: '127.0.0.1',
      docs: true,
      apiKey: 'docs-test-secret-key',
      quiet: true
    })
    t.after(() => app.close())
    const response = await app.inject('/openapi.json')
    assert.equal(response.statusCode, 200)
    const document = response.json<OpenApiDocument>()
    assert.match(document.openapi, /^3\./)
    assert.deepEqual(document.security, [{ bearerAuth: [] }])
    const id = document.paths['/v1/files/{id}']?.get?.parameters?.find(
      (parameter) => parameter.name === 'id'
    )
    assert.deepEqual(id && { name: id.name, in: id.in, required: id.required }, {
      name: 'id',
      in: 'path',
      required: true
    })
    const upload =
      document.paths['/v1/files']?.post?.requestBody?.content['multipart/form-data']?.schema
        .properties?.['file']
    assert.equal(upload?.type, 'string')
    assert.equal(
      upload?.format,
      'binary',
      'the explorer needs a binary schema to render a file input'
    )
    assert.equal(document.paths['/docs'], undefined)
    assert.equal(document.paths['/openapi.json'], undefined)
  })
})
