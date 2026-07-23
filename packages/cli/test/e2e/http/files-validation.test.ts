import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { multipart, assertStatusAndError } from '../helpers/http.js'
import { tinyPng } from '../helpers/fixtures.js'

describe('serve: files content endpoint', () => {
  const server = useServer({ cors: true })

  it('GET /v1/files/:id/content returns 404 for unknown id', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/files/file-deadbeef/content' })
    assertStatusAndError(res, 404, 'file_not_found')
  })

  it('GET /v1/files/:id/content returns the bytes after a POST /v1/files upload', async () => {
    const png = tinyPng()
    const upload = await server().inject({
      method: 'POST',
      url: '/v1/files',
      ...multipart([
        { name: 'file', filename: 'tiny.png', contentType: 'image/png', data: png },
        { name: 'purpose', value: 'image_generation' }
      ])
    })
    assert.equal(upload.statusCode, 200)
    const id = (upload.json() as { id: string }).id
    assert.match(id, /^file-/)

    const res = await server().inject({ method: 'GET', url: `/v1/files/${id}/content` })
    assert.equal(res.statusCode, 200)
    assert.ok(res.rawPayload.equals(png), 'downloaded bytes should match the upload')
  })

  it('GET /v1/files/:id/content sets Cache-Control private with bounded max-age', async () => {
    const upload = await server().inject({
      method: 'POST',
      url: '/v1/files',
      ...multipart([
        { name: 'file', filename: 'tiny.png', contentType: 'image/png', data: tinyPng() },
        { name: 'purpose', value: 'image_generation' }
      ])
    })
    const id = (upload.json() as { id: string }).id
    const res = await server().inject({ method: 'GET', url: `/v1/files/${id}/content` })
    const cc = String(res.headers['cache-control'])
    const m = cc.match(/private,\s*max-age=(\d+)/)
    assert.ok(m, `expected private max-age cache-control, got: ${cc}`)
    const maxAge = Number(m[1])
    assert.ok(maxAge > 0 && maxAge <= 3600, `max-age out of range: ${maxAge}`)
  })
})

describe('serve: files empty list', () => {
  const server = useServer({ cors: true })

  it('GET /v1/files returns an empty list initially', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/files' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { object: string; data: unknown[] }
    assert.equal(body.object, 'list')
    assert.deepEqual(body.data, [])
  })
})

describe('serve: files list + metadata', () => {
  const server = useServer({ cors: true })

  async function upload(): Promise<string> {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/files',
      ...multipart([
        { name: 'file', filename: 'tiny.png', contentType: 'image/png', data: tinyPng() },
        { name: 'purpose', value: 'image_generation' }
      ])
    })
    return (res.json() as { id: string }).id
  }

  it('GET /v1/files lists an uploaded file', async () => {
    const id = await upload()
    const body = (await server().inject({ method: 'GET', url: '/v1/files' })).json() as {
      object: string
      data: Array<{ id: string }>
    }
    assert.equal(body.object, 'list')
    assert.ok(body.data.some((f) => f.id === id))
  })

  it('GET /v1/files/:id returns file metadata', async () => {
    const id = await upload()
    const res = await server().inject({ method: 'GET', url: `/v1/files/${id}` })
    assert.equal(res.statusCode, 200)
    const f = res.json() as {
      id: string
      object: string
      bytes: number
      created_at: number
      filename: string
      purpose: string
      status: string
    }
    assert.equal(f.id, id)
    assert.equal(f.object, 'file')
    assert.equal(typeof f.bytes, 'number')
    assert.equal(typeof f.created_at, 'number')
    assert.equal(f.purpose, 'image_generation')
    assert.equal(f.status, 'uploaded')
  })

  it('GET /v1/files/:id returns 404 for unknown id', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/files/file-nope' })
    assertStatusAndError(res, 404, 'file_not_found')
  })
})
