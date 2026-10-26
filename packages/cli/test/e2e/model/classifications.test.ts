import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError, multipart } from '../helpers/http.js'

const ALIAS = 'test-classifier'
const ROUTE = '/qvac/v1/classifications'

// No src: the addon's bundled MobileNetV3-Small, labels food / report / other.
const CLASSIFICATION_CONFIG = {
  serve: {
    models: {
      [ALIAS]: { type: 'ggml-classification', preload: true }
    }
  }
}

const IMAGE = readFileSync(
  new URL('../../../../sdk-e2e/assets/images/elephant.jpg', import.meta.url)
)
const IMAGE_DATA_URL = `data:image/jpeg;base64,${IMAGE.toString('base64')}`

interface ClassificationsResult {
  object: string
  model: string
  results: { label: string; confidence: number }[]
}

function assertRanked(results: ClassificationsResult['results']): void {
  assert.ok(results.length > 0, 'expected at least one label')
  for (const { label, confidence } of results) {
    assert.ok(label.length > 0, 'expected a non-empty label')
    assert.ok(confidence >= 0 && confidence <= 1, `confidence ${confidence} outside [0, 1]`)
  }
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1]!.confidence >= results[i]!.confidence, 'expected descending order')
  }
}

describe('qvac classifications: real classification model', () => {
  const server = useModelServer(CLASSIFICATION_CONFIG)

  it('ranks every bundled label for an image sent as a data URL', async () => {
    const res = await server().inject({
      method: 'POST',
      url: ROUTE,
      payload: { model: ALIAS, image: IMAGE_DATA_URL }
    })
    assert.equal(res.statusCode, 200, res.body)

    const body = res.json() as ClassificationsResult
    assert.equal(body.object, 'classification')
    assert.equal(body.model, ALIAS)
    assertRanked(body.results)
    assert.deepEqual(body.results.map((r) => r.label).sort(), ['food', 'other', 'report'])
  })

  it('keeps the top label for a multipart upload with top_k', async () => {
    const { payload, headers } = multipart([
      { name: 'model', value: ALIAS },
      { name: 'image', filename: 'elephant.jpg', contentType: 'image/jpeg', data: IMAGE },
      { name: 'top_k', value: '1' }
    ])
    const res = await server().inject({ method: 'POST', url: ROUTE, payload, headers })
    assert.equal(res.statusCode, 200, res.body)

    const { results } = res.json() as ClassificationsResult
    assert.equal(results.length, 1)
    assertRanked(results)
  })

  // Each passes the signature check, but the addon's decoder rejects it.
  const UNDECODABLE: Array<[string, Buffer]> = [
    ['a truncated JPEG', IMAGE.subarray(0, 300)],
    ['the JPEG signature followed by junk', Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4])]
  ]
  for (const [name, bytes] of UNDECODABLE) {
    it(`rejects ${name}`, { timeout: 30_000 }, async () => {
      const image = `data:image/jpeg;base64,${bytes.toString('base64')}`
      const res = await server().inject({
        method: 'POST',
        url: ROUTE,
        payload: { model: ALIAS, image }
      })
      assertStatusAndError(res, 400, 'unsupported_image_format')
    })
  }
})
