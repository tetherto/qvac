import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError, collectSSE, multipart } from '../helpers/http.js'

const ALIAS = 'test-ocr'

const OCR_CONFIG = {
  serve: {
    models: {
      [ALIAS]: {
        model: 'OCR_LATIN',
        preload: true,
        config: { langList: ['en'] }
      }
    }
  }
}

// Reads "This is a text for testing the OCR implementation, ..." and
// "Type to enter text".
const IMAGE = readFileSync(
  new URL('../../../../sdk-e2e/assets/images/ocr-simple-test-png.png', import.meta.url)
)
const IMAGE_DATA_URL = `data:image/png;base64,${IMAGE.toString('base64')}`

interface OcrBlock {
  text: string
  bbox?: [number, number, number, number]
  confidence?: number
}

interface OcrResult {
  object: string
  model: string
  blocks: OcrBlock[]
  stats?: Record<string, number>
}

function joined(blocks: OcrBlock[]): string {
  return blocks.map((b) => b.text).join(' ')
}

describe('qvac ocr: real OCR model', () => {
  const server = useModelServer(OCR_CONFIG)

  function ocr(payload: object) {
    return server().inject({ method: 'POST', url: '/qvac/v1/ocr', payload })
  }

  it('reads the text in an image sent as a data URL', async () => {
    const res = await ocr({ model: ALIAS, image: IMAGE_DATA_URL })
    assert.equal(res.statusCode, 200, res.body)

    const body = res.json() as OcrResult
    assert.equal(body.object, 'ocr')
    assert.equal(body.model, ALIAS)
    assert.ok(body.blocks.length > 0, 'expected recognised blocks')
    assert.match(joined(body.blocks), /OCR/)
    assert.match(joined(body.blocks), /enter/i)

    const [first] = body.blocks
    assert.equal(first!.bbox?.length, 4)
    assert.equal(typeof first!.confidence, 'number')
    assert.ok(Number.isFinite(body.stats?.['totalTime']), 'expected a numeric totalTime')
  })

  it('reads a multipart upload', async () => {
    const { payload, headers } = multipart([
      { name: 'model', value: ALIAS },
      { name: 'image', filename: 'sample.png', contentType: 'image/png', data: IMAGE },
      { name: 'paragraph', value: 'true' }
    ])
    const res = await server().inject({ method: 'POST', url: '/qvac/v1/ocr', payload, headers })
    assert.equal(res.statusCode, 200, res.body)
    assert.match(joined((res.json() as OcrResult).blocks), /OCR/)
  })

  it('streams blocks over SSE and ends with stats', async () => {
    const res = await ocr({ model: ALIAS, image: IMAGE_DATA_URL, stream: true })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)

    const events = collectSSE(res.body)
    assert.equal(events.at(-1)?.data, '[DONE]')

    const done = events.at(-2)?.data as { object: string; stats?: Record<string, number> }
    assert.equal(done.object, 'ocr.done')
    assert.ok(Number.isFinite(done.stats?.['totalTime']), 'expected a numeric totalTime')

    const chunks = events.slice(0, -2).map((e) => e.data as { object: string; blocks: OcrBlock[] })
    assert.ok(chunks.length > 0, 'expected at least one ocr.chunk')
    assert.ok(chunks.every((c) => c.object === 'ocr.chunk'))
    assert.match(joined(chunks.flatMap((c) => c.blocks)), /OCR/)
  })

  // Each passes the signature check but cannot be decoded: OpenCV rejects the
  // truncated PNG, the addon's own BMP reader the junk after `BM`.
  const UNDECODABLE: Array<[string, Buffer]> = [
    ['a truncated PNG', IMAGE.subarray(0, 200)],
    ['BM followed by junk', Buffer.from('BMjunkjunkjunk')]
  ]
  for (const [name, bytes] of UNDECODABLE) {
    for (const stream of [false, true]) {
      it(`rejects ${name} with stream=${stream}`, { timeout: 30_000 }, async () => {
        const image = `data:image/png;base64,${bytes.toString('base64')}`
        const res = await ocr({ model: ALIAS, image, stream })
        assertStatusAndError(res, 400, 'unsupported_image_format')
        assert.doesNotMatch(res.body, /\.png/, 'the server temp path must not leak')
      })
    }
  }
})
