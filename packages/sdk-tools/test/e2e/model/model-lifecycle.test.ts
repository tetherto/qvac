import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { multipart } from '../helpers/http.js'
import { silenceWav } from '../helpers/fixtures.js'

// Unloading mutates the server, so this runs against its own dedicated one and
// stays independent of any other suite.
const server = useModelServer({
  serve: {
    models: {
      'lc-transcribe': { model: 'WHISPER_EN_TINY_Q8_0', preload: true },
      'lc-translate': {
        model: 'WHISPER_EN_TINY_Q8_0',
        type: 'whispercpp-audio-translation',
        preload: true
      }
    }
  }
})

function listedIds(app: ReturnType<typeof server>): Promise<string[]> {
  return app
    .inject({ method: 'GET', url: '/v1/models' })
    .then((res) => (res.json() as { data: Array<{ id: string }> }).data.map((m) => m.id).sort())
}

describe('model lifecycle', () => {
  it('DELETE unloads a model but keeps the alias listed and reloadable', async () => {
    const app = server()
    const registry = app.qvac.registry

    assert.deepEqual(await listedIds(app), ['lc-transcribe', 'lc-translate'])
    assert.equal(registry.getEntry('lc-transcribe')?.state, registry.STATES.READY)

    const del = (
      await app.inject({ method: 'DELETE', url: '/v1/models/lc-transcribe' })
    ).json() as { id: string; deleted: boolean }
    assert.equal(del.id, 'lc-transcribe')
    assert.equal(del.deleted, true)

    // Non-destructive: the entry stays registered, reset to IDLE with no SDK handle.
    const unloaded = registry.getEntry('lc-transcribe')
    assert.equal(unloaded?.state, registry.STATES.IDLE)
    assert.equal(unloaded?.sdkModelId, null)

    // Still listed (it lazy-reloads on the next request).
    assert.deepEqual(await listedIds(app), ['lc-transcribe', 'lc-translate'])

    // Reload path: a follow-up request loads it again and succeeds.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: 'lc-transcribe' },
        { name: 'file', filename: 'silence.wav', contentType: 'audio/wav', data: silenceWav() }
      ])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(registry.getEntry('lc-transcribe')?.state, registry.STATES.READY)
  })
})
