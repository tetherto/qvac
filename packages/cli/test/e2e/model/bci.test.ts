import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError, collectSSE, multipart } from '../helpers/http.js'

const ALIAS = 'test-bci'

// The SDK e2e fixture: decodes deterministically to "not too controversial" on dayIdx 1.
const NEURAL = readFileSync(
  fileURLToPath(
    new URL('../../../../sdk-e2e/assets/neural/neural-not-too-controversial.bin', import.meta.url)
  )
)

const BCI_CONFIG = {
  serve: {
    models: {
      [ALIAS]: {
        model: 'BCI_WINDOWED',
        preload: true,
        config: {
          whisperConfig: { language: 'en', temperature: 0.0 },
          miscConfig: { captionEnabled: false },
          bciConfig: { dayIdx: 1 }
        }
      }
    }
  }
}

const URL_PATH = '/qvac/v1/bci/transcriptions'

function upload(extra: Array<{ name: string; value: string }> = []) {
  return multipart([
    { name: 'model', value: ALIAS },
    ...extra,
    { name: 'file', filename: 'neural.bin', contentType: 'application/octet-stream', data: NEURAL }
  ])
}

describe('qvac bci transcriptions: real BCI model', () => {
  const server = useModelServer(BCI_CONFIG, { enableAdmin: true })

  it('transcribes a recording', async () => {
    const res = await server().inject({ method: 'POST', url: URL_PATH, ...upload() })
    assert.equal(res.statusCode, 200, res.body)
    assert.match((res.json() as { text: string }).text, /controversial/)
  })

  it('returns timed segments with verbose_json', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL_PATH,
      ...upload([{ name: 'response_format', value: 'verbose_json' }])
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { text: string; segments: unknown[] }
    assert.match(body.text, /controversial/)
    assert.ok(body.segments.length > 0)
  })

  it('streams the transcript as server-sent events', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL_PATH,
      ...upload([{ name: 'stream', value: 'true' }])
    })
    assert.equal(res.statusCode, 200, res.body)
    const events = collectSSE(res.body).map((e) => e.data)
    const done = events.find(
      (e): e is { type: string; text: string } =>
        (e as { type?: string }).type === 'transcript.text.done'
    )
    assert.ok(done, res.body)
    assert.match(done.text, /controversial/)
    assert.equal(events.at(-1), '[DONE]')
  })

  it('rejects a truncated recording', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL_PATH,
      payload: {
        model: ALIAS,
        file: `data:application/octet-stream;base64,${NEURAL.subarray(0, 1000).toString('base64')}`
      }
    })
    assertStatusAndError(res, 400, 'invalid_neural_data')
  })
})
