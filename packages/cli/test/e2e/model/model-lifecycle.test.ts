import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'

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

describe('model lifecycle', () => {
  it('DELETE /v1/models/:id unloads a model and drops it from the list', async () => {
    const before = (await server().inject({ method: 'GET', url: '/v1/models' })).json() as {
      data: Array<{ id: string }>
    }
    assert.equal(before.data.length, 2)

    const d1 = (
      await server().inject({ method: 'DELETE', url: '/v1/models/lc-transcribe' })
    ).json() as { id: string; deleted: boolean }
    assert.equal(d1.id, 'lc-transcribe')
    assert.equal(d1.deleted, true)

    const d2 = (
      await server().inject({ method: 'DELETE', url: '/v1/models/lc-translate' })
    ).json() as { id: string; deleted: boolean }
    assert.equal(d2.id, 'lc-translate')
    assert.equal(d2.deleted, true)

    const after = (await server().inject({ method: 'GET', url: '/v1/models' })).json() as {
      data: Array<{ id: string }>
    }
    assert.equal(after.data.length, 0)
  })
})
