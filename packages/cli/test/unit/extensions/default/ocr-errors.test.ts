import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toHttpError } from '@/lib/api/extensions/default/routes/ocr'
import { HttpError } from '@/lib/api/lib/http-error'

describe('OCR decode errors', () => {
  for (const message of [
    'Invalid image file or insufficient data: /private/ocr-input.png',
    'Unsupported image format: BMP bitsPerPixel 16',
    'ocr-ggml: failed to decode image /private/ocr-input.png'
  ]) {
    it(`classifies a code-less SDK error: ${message.split(':')[0]}`, () => {
      const original = new Error(message)
      original.name = 'RPCError'
      const error = toHttpError(original)
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 400)
      assert.equal(error.code, 'unsupported_image_format')
      assert.doesNotMatch(error.message, /private|ocr-input/)
    })
  }

  for (const code of [8109, 8110]) {
    it(`preserves classification by addon code ${code}`, () => {
      const error = toHttpError(Object.assign(new Error('decode rejected'), { code }))
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 400)
      assert.equal(error.code, 'unsupported_image_format')
    })
  }

  it('leaves unrelated failures as server errors', () => {
    for (const error of [
      new Error('Failed to load weights'),
      new Error('Failed to run OCR job'),
      new Error('Unexpected decoder failure'),
      Object.assign(new Error('load failed'), { code: 8101 }),
      'not an Error'
    ]) {
      assert.equal(toHttpError(error), error)
    }
  })
})
