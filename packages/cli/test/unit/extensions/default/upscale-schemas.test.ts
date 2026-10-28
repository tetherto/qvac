import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_UPSCALE_REPEATS,
  UPSCALE_FIELD_CODES,
  upscaleBody
} from '@/serve/extensions/default/schemas/upscale'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function failedPaths(body: unknown): string[] {
  const result = upscaleBody.safeParse(body)
  assert.equal(result.success, false)
  return result.error!.issues.map((i) => i.path.join('/'))
}

describe('upscaleBody', () => {
  it('accepts an uploaded image or a string reference', () => {
    assert.equal(upscaleBody.safeParse({ model: 'up', image: PNG }).success, true)
    assert.equal(upscaleBody.safeParse({ model: 'up', image: 'file-abc' }).success, true)
  })

  it('reads a multipart repeats as a number', () => {
    assert.equal(upscaleBody.parse({ model: 'up', image: PNG, repeats: '2' }).repeats, 2)
  })

  it('accepts repeats from 1 to the cap', () => {
    for (const repeats of [1, MAX_UPSCALE_REPEATS]) {
      assert.equal(upscaleBody.safeParse({ model: 'up', image: PNG, repeats }).success, true)
    }
  })

  it('rejects repeats outside 1 to the cap, or not an integer', () => {
    for (const repeats of [0, MAX_UPSCALE_REPEATS + 1, 1.5, 'two', '-1']) {
      assert.deepEqual(failedPaths({ model: 'up', image: PNG, repeats }), ['repeats'])
    }
  })

  it('rejects an empty image reference', () => {
    assert.deepEqual(failedPaths({ model: 'up', image: '' }), ['image'])
  })

  it('rejects unknown fields', () => {
    const result = upscaleBody.safeParse({ model: 'up', image: PNG, response_format: 'url' })
    assert.equal(result.success, false)
    assert.match(result.error!.issues[0]!.message, /unrecognized key/i)
  })

  // The openai extension maps `image` too; the two must agree or startup fails.
  it('maps image to the same code as the openai extension', () => {
    assert.equal(UPSCALE_FIELD_CODES['image'], 'missing_image')
  })
})
