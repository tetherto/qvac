import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VlaClientRunParams, VlaClientRunResult, VlaHparams } from '@qvac/sdk'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'
import { defaultState } from '@/serve/extensions/default/state'

const ACTIONS = '/qvac/v1/vla/actions'
const MODELS = '/qvac/v1/vla/models'

// The src does not resolve, so a request that reaches the model load fails with
// a 503. Every input error below must therefore be raised before the load.
const MODELLESS_CONFIG = {
  serve: {
    models: {
      smolvla: { type: 'vla', src: 'hyper://example.invalid/smolvla', preload: false },
      ocr: { type: 'ggml-ocr', src: 'hyper://example.invalid/ocr', preload: false }
    }
  }
} as const

const STUB_CONFIG = {
  serve: {
    models: { smolvla: { type: 'vla', src: '/models/smolvla.gguf', preload: false } }
  }
} as const

const SIZE = 4
const HPARAMS: VlaHparams = {
  chunkSize: 2,
  actionDim: 3,
  maxActionDim: 4,
  maxStateDim: 6,
  tokenizerMaxLength: 5,
  visionImageSize: SIZE,
  numCameras: 2,
  stateInputMode: 'continuous',
  imageInputMode: 'pixels'
}

const FRAME = { pixels: Buffer.alloc(2 * 2 * 3, 128).toString('base64'), width: 2, height: 2 }
const BODY = { model: 'smolvla', images: [FRAME, FRAME], tokens: [7, 8, 9], state: [0.1, 0.2] }

function addonError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code })
}

describe('qvac vla: validation', () => {
  const server = useServer({ config: MODELLESS_CONFIG })

  function post(payload: object) {
    return server().inject({ method: 'POST', url: ACTIONS, payload })
  }

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: ACTIONS,
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing or malformed fields return 400 before the load', async () => {
    assertStatusAndError(await post({ ...BODY, model: undefined }), 400, 'missing_model')
    assertStatusAndError(await post({ ...BODY, images: [] }), 400, 'invalid_images')
    assertStatusAndError(await post({ ...BODY, images: [{ tensor: '!!' }] }), 400, 'invalid_images')
    assertStatusAndError(
      await post({ ...BODY, images: [{ tensor: 'abcde' }] }),
      400,
      'invalid_images'
    )
    assertStatusAndError(await post({ ...BODY, tokens: undefined }), 400, 'invalid_tokens')
    assertStatusAndError(await post({ ...BODY, tokens: [5, -1] }), 400, 'invalid_tokens')
    assertStatusAndError(await post({ ...BODY, attentionMask: [2] }), 400, 'invalid_attention_mask')
    assertStatusAndError(await post({ ...BODY, prompt: 'pick' }), 400, 'invalid_request')
  })

  it('a non-vla model returns 400', async () => {
    assertStatusAndError(await post({ ...BODY, model: 'ocr' }), 400, 'invalid_model_type')
    assertStatusAndError(
      await server().inject({ method: 'GET', url: `${MODELS}/ocr` }),
      400,
      'invalid_model_type'
    )
  })

  it('an unknown model returns 404', async () => {
    assertStatusAndError(await post({ ...BODY, model: 'nope' }), 404, 'model_not_found')
    assertStatusAndError(
      await server().inject({
        method: 'POST',
        url: `${MODELS}/nope/embodiment`,
        payload: { embodiment: 'libero_sim' }
      }),
      404,
      'model_not_found'
    )
  })

  it('a malformed embodiment returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: `${MODELS}/smolvla/embodiment`,
      payload: { embodiment: { tag: 'a', catId: 1 } }
    })
    assertStatusAndError(res, 400, 'invalid_embodiment')
  })
})

describe('qvac vla: actions and hparams against a stubbed SDK', () => {
  const server = useServer({
    config: STUB_CONFIG,
    loadModelOverride: () => Promise.resolve('sdk-vla')
  })

  function state() {
    return defaultState(server().qvac)
  }

  function stubHparams(hparams: VlaHparams = HPARAMS) {
    state().vlaHparamsOverride = () => Promise.resolve({ hparams, backendName: 'Metal' })
  }

  function stubRun(calls: VlaClientRunParams[] = [], result?: () => Promise<VlaClientRunResult>) {
    state().vlaOverride = (params) => {
      calls.push(params)
      const run =
        result?.() ??
        Promise.resolve({
          actions: Float32Array.from([1, 2, 3, 4, 5, 6]),
          actionDim: 3,
          chunkSize: 2,
          stats: { totalTime: 9, visionMs: 2 }
        })
      return Object.assign(run, { requestId: 'vla-req' })
    }
  }

  it('preprocesses the frames, pads the buffers and returns the chunk as rows', async () => {
    stubHparams()
    const calls: VlaClientRunParams[] = []
    stubRun(calls)

    const res = await server().inject({ method: 'POST', url: ACTIONS, payload: BODY })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), {
      object: 'vla.actions',
      model: 'smolvla',
      chunk_size: 2,
      action_dim: 3,
      actions: [
        [1, 2, 3],
        [4, 5, 6]
      ],
      stats: { totalTime: 9, visionMs: 2 }
    })

    const call = calls[0]!
    assert.equal(call.modelId, 'sdk-vla')
    assert.equal(call.images.length, 2)
    assert.equal(call.images[0]!.length, 3 * SIZE * SIZE)
    assert.equal(call.imgWidth, SIZE)
    assert.deepEqual([...call.tokens], [7, 8, 9, 0, 0])
    assert.deepEqual([...call.mask], [1, 1, 1, 0, 0])
    assert.equal(call.state.length, 6)
  })

  it('accepts full-size 1080p frames', async () => {
    stubHparams()
    const calls: VlaClientRunParams[] = []
    stubRun(calls)
    const frame = {
      pixels: Buffer.alloc(1920 * 1080 * 3, 64).toString('base64'),
      width: 1920,
      height: 1080
    }
    const res = await server().inject({
      method: 'POST',
      url: ACTIONS,
      payload: { ...BODY, images: [frame, frame] }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(calls[0]!.images[0]!.length, 3 * SIZE * SIZE)
  })

  it('rejects a camera count the model does not take, without running it', async () => {
    stubHparams()
    const calls: VlaClientRunParams[] = []
    stubRun(calls)
    const res = await server().inject({
      method: 'POST',
      url: ACTIONS,
      payload: { ...BODY, images: [FRAME] }
    })
    assertStatusAndError(res, 400, 'invalid_images')
    assert.equal(calls.length, 0)
  })

  it('maps an inference the worker refuses to 400 and a busy model to 429', async () => {
    stubHparams()
    stubRun([], () => Promise.reject(addonError('bad tensor', 30004)))
    assertStatusAndError(
      await server().inject({ method: 'POST', url: ACTIONS, payload: BODY }),
      400,
      'invalid_vla_request'
    )
    stubRun([], () => Promise.reject(addonError('switch in flight', 30007)))
    assertStatusAndError(
      await server().inject({ method: 'POST', url: ACTIONS, payload: BODY }),
      429,
      'request_rejected_by_policy'
    )
  })

  it('returns hparams and the backend name', async () => {
    stubHparams()
    const res = await server().inject({ method: 'GET', url: `${MODELS}/smolvla` })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), {
      object: 'vla.model',
      model: 'smolvla',
      backend_name: 'Metal',
      hparams: HPARAMS
    })
  })

  const GROOT: VlaHparams = { ...HPARAMS, imageInputMode: 'patches', imagePatchElems: 12 }

  it('switches the embodiment and returns the new hparams', async () => {
    stubHparams(GROOT)
    const calls: unknown[] = []
    state().vlaSetEmbodimentOverride = (params) => {
      calls.push(params)
      return Promise.resolve({
        hparams: { ...HPARAMS, numCameras: 1, selectedEmbodimentTag: 'real_droid' }
      })
    }
    const res = await server().inject({
      method: 'POST',
      url: `${MODELS}/smolvla/embodiment`,
      payload: { embodiment: { tag: 'real_droid', numCameras: 1 } }
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { hparams: VlaHparams; backend_name?: string }
    assert.equal(body.hparams.selectedEmbodimentTag, 'real_droid')
    assert.equal(body.backend_name, undefined)
    assert.deepEqual(calls, [
      { modelId: 'sdk-vla', embodiment: { tag: 'real_droid', numCameras: 1 } }
    ])
  })

  it('sends a GR00T prompt unpadded, since its tokenizerMaxLength is 0', async () => {
    stubHparams({ ...GROOT, tokenizerMaxLength: 0 })
    const calls: VlaClientRunParams[] = []
    stubRun(calls)
    const tensor = Buffer.alloc(12 * 4).toString('base64')
    const res = await server().inject({
      method: 'POST',
      url: ACTIONS,
      payload: { ...BODY, images: [{ tensor }, { tensor }], noise: new Array(8).fill(0) }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual([...calls[0]!.tokens], [7, 8, 9])
    assert.deepEqual([...calls[0]!.mask], [1, 1, 1])
  })

  it('refuses an embodiment switch on a model that is not GR00T, without calling the SDK', async () => {
    stubHparams()
    let called = false
    state().vlaSetEmbodimentOverride = () => {
      called = true
      return Promise.resolve({ hparams: HPARAMS })
    }
    const res = await server().inject({
      method: 'POST',
      url: `${MODELS}/smolvla/embodiment`,
      payload: { embodiment: 'libero_sim' }
    })
    assertStatusAndError(res, 400, 'invalid_embodiment')
    assert.equal(called, false)
  })

  it('refuses a switch while an action request holds the model, and the reverse', async () => {
    stubHparams(GROOT)
    let finish!: () => void
    stubRun(
      [],
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ actions: Float32Array.from([1, 2, 3, 4, 5, 6]), actionDim: 3, chunkSize: 2 })
        })
    )
    let switches = 0
    state().vlaSetEmbodimentOverride = () => {
      switches++
      return Promise.resolve({ hparams: GROOT })
    }
    const tensor = Buffer.alloc(12 * 4).toString('base64')
    const action = server().inject({
      method: 'POST',
      url: ACTIONS,
      payload: { ...BODY, images: [{ tensor }, { tensor }], noise: new Array(8).fill(0) }
    })
    while (finish === undefined) await new Promise((r) => setImmediate(r))

    const switchTo = () =>
      server().inject({
        method: 'POST',
        url: `${MODELS}/smolvla/embodiment`,
        payload: { embodiment: 'real_droid' }
      })
    assertStatusAndError(await switchTo(), 429, 'request_rejected_by_policy')
    assert.equal(switches, 0)

    finish()
    assert.equal((await action).statusCode, 200)
    assert.equal((await switchTo()).statusCode, 200)
    assert.equal(switches, 1)
  })

  it('maps an embodiment the addon refuses to 400 and a busy model to 429', async () => {
    stubHparams(GROOT)
    state().vlaSetEmbodimentOverride = () =>
      Promise.reject(addonError('unknown embodiment tag', 30004))
    const switchTo = () =>
      server().inject({
        method: 'POST',
        url: `${MODELS}/smolvla/embodiment`,
        payload: { embodiment: 'mars_rover' }
      })
    assertStatusAndError(await switchTo(), 400, 'invalid_embodiment')

    state().vlaSetEmbodimentOverride = () => Promise.reject(addonError('job in flight', 30007))
    assertStatusAndError(await switchTo(), 429, 'request_rejected_by_policy')
  })

  it('maps a single-embodiment GGUF refusing the switch to 400', async () => {
    stubHparams(GROOT)
    state().vlaSetEmbodimentOverride = () =>
      Promise.reject(
        addonError('GrootModel::setEmbodiment: this GGUF stores a single embodiment row', 30001)
      )
    const res = await server().inject({
      method: 'POST',
      url: `${MODELS}/smolvla/embodiment`,
      payload: { embodiment: 'libero_sim' }
    })
    assertStatusAndError(res, 400, 'invalid_embodiment')

    state().vlaSetEmbodimentOverride = () =>
      Promise.reject(addonError('grootFillEmbodimentRow: short read for embodiment row 3', 30001))
    const failed = await server().inject({
      method: 'POST',
      url: `${MODELS}/smolvla/embodiment`,
      payload: { embodiment: 'libero_sim' }
    })
    assert.equal(failed.statusCode, 500, failed.body)
  })

  it('refuses a second action request on a busy model, without running it', async () => {
    stubHparams()
    let finish!: () => void
    let runs = 0
    stubRun([], () => {
      runs++
      return new Promise((resolve) => {
        finish = () =>
          resolve({ actions: Float32Array.from([1, 2, 3, 4, 5, 6]), actionDim: 3, chunkSize: 2 })
      })
    })
    const first = server().inject({ method: 'POST', url: ACTIONS, payload: BODY })
    while (finish === undefined) await new Promise((r) => setImmediate(r))

    assertStatusAndError(
      await server().inject({ method: 'POST', url: ACTIONS, payload: BODY }),
      429,
      'request_rejected_by_policy'
    )
    assert.equal(runs, 1)
    finish()
    assert.equal((await first).statusCode, 200)
  })

  it('rejects a π₀.₅ mask with a hole, and leaves an inference failure a server error', async () => {
    stubHparams({ ...HPARAMS, stateInputMode: 'discrete' })
    const calls: VlaClientRunParams[] = []
    stubRun(calls)
    const noise = new Array(8).fill(0)
    assertStatusAndError(
      await server().inject({
        method: 'POST',
        url: ACTIONS,
        payload: { ...BODY, tokens: [7, 8, 9, 10], attentionMask: [1, 0, 1, 1], noise }
      }),
      400,
      'invalid_attention_mask'
    )
    assert.equal(calls.length, 0)

    stubRun([], () => Promise.reject(addonError('graph allocation failed', 30010)))
    const res = await server().inject({ method: 'POST', url: ACTIONS, payload: { ...BODY, noise } })
    assert.equal(res.statusCode, 500, res.body)
  })
})
