import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLASSIFICATIONS_FIELD_CODES,
  classificationsBody
} from '@/serve/extensions/default/schemas/classifications'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

describe('classificationsBody', () => {
  it('accepts an uploaded image or a string reference', () => {
    assert.equal(classificationsBody.safeParse({ model: 'cls', image: PNG }).success, true)
    assert.equal(classificationsBody.safeParse({ model: 'cls', image: 'file-abc' }).success, true)
  })

  it('reads a multipart top_k as an integer', () => {
    const result = classificationsBody.parse({ model: 'cls', image: PNG, top_k: '2' })
    assert.equal(result.top_k, 2)
  })

  for (const topK of [0, -1, 1.5, '1.5', 'two', '']) {
    it(`rejects top_k ${JSON.stringify(topK)}`, () => {
      const result = classificationsBody.safeParse({ model: 'cls', image: PNG, top_k: topK })
      assert.equal(result.success, false)
      assert.deepEqual(
        result.error!.issues.map((i) => i.path.join('/')),
        ['top_k']
      )
    })
  }

  it('rejects an empty image reference', () => {
    const result = classificationsBody.safeParse({ model: 'cls', image: '' })
    assert.equal(result.success, false)
    assert.equal(result.error!.issues[0]!.path[0], 'image')
  })

  it('rejects unknown fields', () => {
    const result = classificationsBody.safeParse({ model: 'cls', image: PNG, topK: 2 })
    assert.equal(result.success, false)
    assert.match(result.error!.issues[0]!.message, /unrecognized key/i)
  })

  // The openai extension maps `image` too; the two must agree or startup fails.
  it('maps image to the same code as the openai extension', () => {
    assert.equal(CLASSIFICATIONS_FIELD_CODES['image'], 'missing_image')
  })
})
