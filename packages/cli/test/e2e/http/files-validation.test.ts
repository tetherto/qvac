import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertError, multipart } from '../helpers/http.js'
import { tinyPng } from '../helpers/fixtures.js'

// Ported from cli.bats "Serve: files content-download endpoint".
describe('serve: files content endpoint', () => {
  const server = useServer({ cors: true })

  it('GET /v1/files/:id/content returns 404 for unknown id', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/files/file-deadbeef/content' })
    assert.equal(res.statusCode, 404)
    assertError(res, 'file_not_found')
  })

  it('GET /v1/files/:id/content returns the bytes after a POST /v1/files upload', async () => {
    const png = tinyPng()
    const upload = await server().inject({
      method: 'POST', url: '/v1/files',
      ...multipart([{ name: 'file', filename: 'tiny.png', contentType: 'image/png', data: png }, { name: 'purpose', value: 'image_generation' }])
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
      method: 'POST', url: '/v1/files',
      ...multipart([{ name: 'file', filename: 'tiny.png', contentType: 'image/png', data: tinyPng() }, { name: 'purpose', value: 'image_generation' }])
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
