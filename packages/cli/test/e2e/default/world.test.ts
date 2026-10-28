import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SDK_SERVER_ERROR_CODES,
  type WorldSceneClientParams,
  type WorldSceneResult,
  type WorldSceneResultWithPack,
  type WorldStepClientParams,
  type WorldStepResult
} from '@qvac/sdk'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError, collectSSE, multipart } from '../helpers/http.js'
import { tinyJpeg, tinyPng } from '../helpers/fixtures.js'
import { defaultState } from '@/serve/extensions/default/state'

const SCENES = '/qvac/v1/world/scenes'

// The src does not resolve, so a request that reaches the model load fails with
// a 503. Every input error below must therefore be raised before the load.
const MODELLESS_CONFIG = {
  serve: {
    models: {
      world: {
        type: 'sdcpp-generation',
        src: 'hyper://example.invalid/abot',
        preload: false,
        config: { mode: 'world' }
      },
      'image-model': {
        type: 'sdcpp-generation',
        src: 'hyper://example.invalid/sd',
        preload: false
      }
    }
  }
} as const

const STUB_CONFIG = {
  serve: {
    models: {
      world: {
        type: 'sdcpp-generation',
        src: '/models/abot.gguf',
        preload: false,
        config: { mode: 'world' }
      }
    }
  }
} as const

const PNG_DATA_URL = `data:image/png;base64,${tinyPng().toString('base64')}`
const SCENE = { model: 'world', prompt: '| unknown | a path', image: PNG_DATA_URL }

describe('qvac world: validation', () => {
  const server = useServer({ config: MODELLESS_CONFIG })

  function createScene(payload: object) {
    return server().inject({ method: 'POST', url: SCENES, payload })
  }

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: SCENES,
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model, prompt or image returns 400', async () => {
    assertStatusAndError(await createScene({ ...SCENE, model: undefined }), 400, 'missing_model')
    assertStatusAndError(await createScene({ ...SCENE, prompt: '' }), 400, 'missing_prompt')
    assertStatusAndError(await createScene({ ...SCENE, image: undefined }), 400, 'missing_image')
  })

  it('bad dimensions return 400', async () => {
    assertStatusAndError(await createScene({ ...SCENE, width: 100 }), 400, 'invalid_dimensions')
    assertStatusAndError(
      await createScene({ ...SCENE, width: 4096, height: 4096 }),
      400,
      'invalid_dimensions'
    )
  })

  it('a non-image first frame returns 400', async () => {
    const res = await createScene({
      ...SCENE,
      image: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`
    })
    assertStatusAndError(res, 400, 'unsupported_image_format')
  })

  it('an image over 3 MB returns 400', async () => {
    const big = Buffer.concat([tinyPng(), Buffer.alloc(3 * 1024 * 1024)])
    const res = await server().inject({
      method: 'POST',
      url: SCENES,
      ...multipart([
        { name: 'model', value: 'world' },
        { name: 'prompt', value: 'a path' },
        { name: 'image', filename: 'big.png', contentType: 'image/png', data: big }
      ])
    })
    assertStatusAndError(res, 400, 'image_too_large')
  })

  it('a non-world model returns 400', async () => {
    assertStatusAndError(
      await createScene({ ...SCENE, model: 'image-model' }),
      400,
      'invalid_model_type'
    )
  })

  it('an unknown scene returns 404', async () => {
    assertStatusAndError(
      await server().inject({ method: 'GET', url: `${SCENES}/scene_nope` }),
      404,
      'scene_not_found'
    )
    assertStatusAndError(
      await server().inject({ method: 'POST', url: `${SCENES}/scene_nope/steps`, payload: {} }),
      404,
      'scene_not_found'
    )
  })
})

function fakeScene(stats: Promise<WorldSceneResult['stats'] extends Promise<infer S> ? S : never>) {
  return { requestId: 'scene-req', stats }
}

function fakeStep(frames: Uint8Array[], stats = { stepMs: 5, totalSteps: 1 }): WorldStepResult {
  return {
    requestId: 'step-req',
    frameStream: (async function* () {
      for (const frame of frames) yield frame
    })(),
    progressStream: (async function* () {})(),
    frames: Promise.resolve(frames),
    stats: Promise.resolve(stats)
  }
}

describe('qvac world: scenes and steps against a stubbed SDK', () => {
  const server = useServer({
    config: STUB_CONFIG,
    loadModelOverride: () => Promise.resolve('sdk-world')
  })

  function state() {
    return defaultState(server().qvac)
  }

  async function createScene(payload: object = SCENE) {
    const res = await server().inject({ method: 'POST', url: SCENES, payload })
    assert.equal(res.statusCode, 201, res.body)
    return res.json() as { id: string; status: string; width?: number; pack?: string }
  }

  function stubScene(calls: WorldSceneClientParams[] = []) {
    state().worldCreateSceneOverride = ((params: WorldSceneClientParams) => {
      calls.push(params)
      const result = fakeScene(Promise.resolve({ width: 832, height: 480, sceneCreateMs: 12 }))
      return params.returnPack === true
        ? ({
            ...result,
            scene: Promise.resolve(new Uint8Array([1, 2, 3]))
          } as WorldSceneResultWithPack)
        : result
    }) as never
  }

  it('creates a scene, then steps it with the held keys', async () => {
    const calls: WorldSceneClientParams[] = []
    stubScene(calls)
    const steps: WorldStepClientParams[] = []
    state().worldStepOverride = (params) => {
      steps.push(params)
      return fakeStep([tinyPng(), tinyPng()])
    }

    const scene = await createScene({ ...SCENE, width: 640, height: 352 })
    assert.equal(scene.status, 'active')
    assert.equal(scene.width, 832)
    assert.equal(scene.pack, undefined)
    assert.equal(calls[0]!.modelId, 'sdk-world')
    assert.equal(calls[0]!.width, 640)
    assert.deepEqual([...calls[0]!.image.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])

    const res = await server().inject({
      method: 'POST',
      url: `${SCENES}/${scene.id}/steps`,
      payload: { keys: ['W', 'J'] }
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { output_format: string; data: unknown[]; stats: object }
    assert.equal(body.output_format, 'png')
    assert.equal(body.data.length, 2)
    assert.deepEqual(body.stats, { step_ms: 5, total_steps: 1 })
    assert.deepEqual(steps, [{ modelId: 'sdk-world', keys: ['W', 'J'] }])
  })

  it('returns the pack when asked', async () => {
    stubScene()
    const scene = await createScene({ ...SCENE, returnPack: true })
    assert.equal(scene.pack, Buffer.from([1, 2, 3]).toString('base64'))
  })

  it('retires the older scene when a new one is created on the model', async () => {
    stubScene()
    state().worldStepOverride = () => fakeStep([tinyPng()])
    const first = await createScene()
    const second = await createScene()

    const stale = await server().inject({ method: 'GET', url: `${SCENES}/${first.id}` })
    assert.equal((stale.json() as { status: string }).status, 'replaced')
    assertStatusAndError(
      await server().inject({ method: 'POST', url: `${SCENES}/${first.id}/steps`, payload: {} }),
      409,
      'scene_replaced'
    )
    const live = await server().inject({
      method: 'POST',
      url: `${SCENES}/${second.id}/steps`,
      payload: {}
    })
    assert.equal(live.statusCode, 200, live.body)
  })

  it('streams frames as server-sent events', async () => {
    stubScene()
    state().worldStepOverride = () => fakeStep([tinyJpeg(), tinyJpeg(), tinyJpeg()])
    const scene = await createScene()

    const res = await server().inject({
      method: 'POST',
      url: `${SCENES}/${scene.id}/steps`,
      payload: { stream: true }
    })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)
    const events = collectSSE(res.body)
    const frames = events.filter((e) => (e.data as { type?: string }).type === 'world.step.frame')
    assert.equal(frames.length, 3)
    assert.equal((frames[0]!.data as { output_format: string }).output_format, 'jpeg')
    assert.equal((events.at(-2)!.data as { type: string; frames: number }).frames, 3)
    assert.equal(events.at(-1)!.data, '[DONE]')
  })

  it('maps a scene the worker refuses to 400 invalid_scene', async () => {
    state().worldCreateSceneOverride = (() =>
      fakeScene(
        Promise.reject(
          Object.assign(new Error('The first-frame image is not a readable PNG or JPEG.'), {
            code: SDK_SERVER_ERROR_CODES.PLUGIN_REQUEST_VALIDATION_FAILED
          })
        )
      )) as never
    const res = await server().inject({ method: 'POST', url: SCENES, payload: SCENE })
    assertStatusAndError(res, 400, 'invalid_scene')
  })
})
