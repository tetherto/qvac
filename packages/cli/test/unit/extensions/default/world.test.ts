import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  WORLD_FIELD_CODES,
  worldSceneBody,
  worldStepBody
} from '@/serve/extensions/default/schemas/world'
import { createWorldScenesStore } from '@/serve/extensions/default/world-scenes-store'
import { extensionErrorCodes } from '@/serve/core/extensions'
import openaiExtension from '@/serve/extensions/openai'
import defaultExtension from '@/serve/extensions/default'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const SCENE = { model: 'world', prompt: 'a path', image: PNG }

function failedPaths(result: {
  success: boolean
  error?: { issues: Array<{ path: PropertyKey[] }> }
}): string[] {
  assert.equal(result.success, false)
  return result.error!.issues.map((i) => i.path.join('/'))
}

describe('worldSceneBody', () => {
  it('accepts an uploaded image or a string reference', () => {
    assert.equal(worldSceneBody.safeParse(SCENE).success, true)
    assert.equal(worldSceneBody.safeParse({ ...SCENE, image: 'file-abc' }).success, true)
  })

  it('reads multipart dimensions and returnPack from their string form', () => {
    const body = worldSceneBody.parse({ ...SCENE, width: '640', height: '352', returnPack: 'true' })
    assert.equal(body.width, 640)
    assert.equal(body.height, 352)
    assert.equal(body.returnPack, true)
  })

  it('rejects a side that is not a multiple of 32 or is over 4096', () => {
    for (const width of [0, 100, 4128, 'wide']) {
      assert.deepEqual(failedPaths(worldSceneBody.safeParse({ ...SCENE, width })), ['width'])
    }
  })

  it('rejects an area over 1920x1088', () => {
    assert.equal(worldSceneBody.safeParse({ ...SCENE, width: 1920, height: 1088 }).success, true)
    assert.deepEqual(
      failedPaths(worldSceneBody.safeParse({ ...SCENE, width: 1920, height: 1120 })),
      ['width']
    )
  })

  it('checks the area against the default for a side left out', () => {
    assert.deepEqual(failedPaths(worldSceneBody.safeParse({ ...SCENE, height: 2560 })), ['height'])
    assert.equal(worldSceneBody.safeParse({ ...SCENE, height: 1088 }).success, true)
  })

  it('requires a prompt', () => {
    assert.deepEqual(failedPaths(worldSceneBody.safeParse({ ...SCENE, prompt: '' })), ['prompt'])
  })

  it('rejects unknown fields', () => {
    const result = worldSceneBody.safeParse({ ...SCENE, seed: 1 })
    assert.equal(result.success, false)
    assert.match(result.error!.issues[0]!.message, /unrecognized key/i)
  })
})

describe('worldStepBody', () => {
  it('accepts no keys or an array', () => {
    assert.equal(worldStepBody.safeParse({}).success, true)
    assert.deepEqual(worldStepBody.parse({ keys: ['W', 'J'] }).keys, ['W', 'J'])
  })

  it('rejects keys or stream sent as strings', () => {
    assert.deepEqual(failedPaths(worldStepBody.safeParse({ keys: '["S"]' })), ['keys'])
    assert.deepEqual(failedPaths(worldStepBody.safeParse({ stream: 'true' })), ['stream'])
  })

  it('rejects an unknown key', () => {
    assert.deepEqual(failedPaths(worldStepBody.safeParse({ keys: ['W', 'Q'] })), ['keys/1'])
  })
})

describe('WORLD_FIELD_CODES', () => {
  it('agrees with the openai extension on shared fields', () => {
    assert.doesNotThrow(() => extensionErrorCodes([openaiExtension, defaultExtension]))
    assert.equal(WORLD_FIELD_CODES['prompt'], 'missing_prompt')
  })
})

describe('createWorldScenesStore', () => {
  it('keeps one active scene per model', () => {
    const store = createWorldScenesStore()
    const first = store.add({ alias: 'world', loadCount: 1 })
    const other = store.add({ alias: 'world-2', loadCount: 1 })
    assert.equal(store.isActive(first, 1), true)

    const second = store.add({ alias: 'world', loadCount: 1 })
    assert.equal(store.isActive(first, 1), false)
    assert.equal(store.isActive(second, 1), true)
    assert.equal(store.isActive(other, 1), true)
  })

  it('treats a reloaded or unloaded model as having lost its scene', () => {
    const store = createWorldScenesStore()
    const scene = store.add({ alias: 'world', loadCount: 1 })
    assert.equal(store.isActive(scene, 2), false)
    assert.equal(store.isActive(scene, undefined), false)
  })

  it('evicts the oldest retired ids and never a live one', () => {
    const store = createWorldScenesStore(2)
    const live = store.add({ alias: 'a', loadCount: 1 })
    const retired = store.add({ alias: 'b', loadCount: 1 })
    const latest = store.add({ alias: 'b', loadCount: 1 })

    assert.equal(store.get(retired.id), undefined)
    assert.equal(store.get(live.id), live)
    assert.equal(store.get(latest.id), latest)
  })
})
