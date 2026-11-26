import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

const ALIAS = 'test-smolvla'

const VLA_CONFIG = {
  serve: {
    models: {
      [ALIAS]: {
        model: 'SMOLVLA_LIBERO_VISION_Q8',
        preload: true,
        config: { backend: ['cpu'] }
      }
    }
  }
}

interface VlaModelBody {
  backend_name?: string | null
  hparams: {
    chunkSize: number
    actionDim: number
    maxStateDim: number
    tokenizerMaxLength: number
    visionImageSize: number
    numCameras?: number
  }
}

interface VlaActionsBody {
  chunk_size: number
  action_dim: number
  actions: number[][]
}

function grayFrame(width: number, height: number) {
  return { pixels: Buffer.alloc(width * height * 3, 128).toString('base64'), width, height }
}

describe('qvac vla: real SmolVLA model', () => {
  const server = useModelServer(VLA_CONFIG)

  async function hparams() {
    const res = await server().inject({ method: 'GET', url: `/qvac/v1/vla/models/${ALIAS}` })
    assert.equal(res.statusCode, 200, res.body)
    return (res.json() as VlaModelBody).hparams
  }

  it('reports the model hyperparameters', async () => {
    const hp = await hparams()
    assert.ok(hp.chunkSize > 0)
    assert.ok(hp.actionDim > 0)
    assert.ok(hp.visionImageSize > 0)
    assert.ok(hp.tokenizerMaxLength > 0)
  })

  it('predicts an action chunk from raw camera frames', async () => {
    const hp = await hparams()
    const cameras = hp.numCameras ?? 2
    // SmolVLA samples its own noise prior when none is sent.
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/vla/actions',
      payload: {
        model: ALIAS,
        images: Array.from({ length: cameras }, () => grayFrame(64, 48)),
        state: [0, 0, 0, 0, 0, 0, 0, 0],
        tokens: [1, 2, 3, 4]
      }
    })
    assertChunk(res.statusCode, res.body, hp)
  })

  it('rejects the wrong camera count', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/vla/actions',
      payload: { model: ALIAS, images: [grayFrame(8, 8)], tokens: [1] }
    })
    assertStatusAndError(res, 400, 'invalid_images')
  })

  it('refuses an embodiment switch on a model that is not GR00T', async () => {
    const res = await server().inject({
      method: 'POST',
      url: `/qvac/v1/vla/models/${ALIAS}/embodiment`,
      payload: { embodiment: 'libero_sim' }
    })
    assertStatusAndError(res, 400, 'invalid_embodiment')
  })
})

function assertChunk(status: number, raw: string, hp: VlaModelBody['hparams']): void {
  assert.equal(status, 200, raw)
  const body = JSON.parse(raw) as VlaActionsBody
  assert.equal(body.chunk_size, hp.chunkSize)
  assert.equal(body.action_dim, hp.actionDim)
  assert.equal(body.actions.length, body.chunk_size)
  for (const row of body.actions) {
    assert.equal(row.length, body.action_dim)
    assert.ok(row.every(Number.isFinite))
  }
}
