import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyRequest } from 'fastify'
import { HttpError } from '@/serve/lib/http-error'
import { BMP, JPEG, PNG, createImageInput } from '@/serve/lib/image-input'

// A direct upload resolves without touching the request beyond its multipart files.
function fakeRequest(): FastifyRequest {
  return {} as FastifyRequest
}

function rejection(fn: () => void): HttpError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof HttpError)
    return err
  }
  assert.fail('expected a rejection')
}

describe('createImageInput', () => {
  const pngBytes = Buffer.from([...PNG.signature, 0, 0])

  it('keeps an image whose signature matches one of the formats', () => {
    const image = createImageInput([PNG, JPEG])
    const req = fakeRequest()
    image.read(req, pngBytes)
    assert.equal(image.get(req), pngBytes)
  })

  it('rejects a PNG that matches only the first four signature bytes', () => {
    const image = createImageInput([PNG, JPEG])
    const err = rejection(() =>
      image.read(fakeRequest(), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    )
    assert.equal(err.status, 400)
    assert.equal(err.code, 'unsupported_image_format')
    assert.match(err.message, /expected a PNG or JPEG image/)
  })

  it('names every accepted format in the rejection', () => {
    const image = createImageInput([PNG, JPEG, BMP])
    const err = rejection(() => image.read(fakeRequest(), Buffer.from('hello')))
    assert.match(err.message, /expected a PNG, JPEG or BMP image/)
  })
})
