import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OCR_FIELD_CODES, ocrBody } from '@/serve/extensions/default/schemas/ocr'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

describe('ocrBody', () => {
  it('accepts an uploaded image or a string reference', () => {
    assert.equal(ocrBody.safeParse({ model: 'ocr', image: PNG }).success, true)
    assert.equal(ocrBody.safeParse({ model: 'ocr', image: 'file-abc' }).success, true)
  })

  it('reads multipart flags as booleans', () => {
    const result = ocrBody.parse({ model: 'ocr', image: PNG, stream: 'true', paragraph: 'false' })
    assert.equal(result.stream, true)
    assert.equal(result.paragraph, false)
  })

  it('rejects a flag that is neither a boolean nor "true"/"false"', () => {
    const result = ocrBody.safeParse({ model: 'ocr', image: PNG, stream: 'yes' })
    assert.equal(result.success, false)
    assert.deepEqual(
      result.error!.issues.map((i) => i.path.join('/')),
      ['stream']
    )
  })

  it('rejects an empty image reference', () => {
    const result = ocrBody.safeParse({ model: 'ocr', image: '' })
    assert.equal(result.success, false)
    assert.equal(result.error!.issues[0]!.path[0], 'image')
  })

  it('rejects unknown fields', () => {
    const result = ocrBody.safeParse({ model: 'ocr', image: PNG, options: {} })
    assert.equal(result.success, false)
    assert.match(result.error!.issues[0]!.message, /unrecognized key/i)
  })

  // The openai extension maps `image` too; the two must agree or startup fails.
  it('maps image to the same code as the openai extension', () => {
    assert.equal(OCR_FIELD_CODES['image'], 'missing_image')
  })
})
