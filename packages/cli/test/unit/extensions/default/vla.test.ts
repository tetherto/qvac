import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VlaHparams } from '@qvac/sdk'
import {
  VLA_FIELD_CODES,
  vlaActionsBody,
  vlaEmbodimentBody
} from '@/serve/extensions/default/schemas/vla'
import { buildRunParams } from '@/serve/extensions/default/routes/vla'
import { HttpError } from '@/serve/lib/http-error'
import { extensionErrorCodes } from '@/serve/core/extensions'
import openaiExtension from '@/serve/extensions/openai'
import defaultExtension from '@/serve/extensions/default'

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

function pixels(width = 2, height = 2): { pixels: string; width: number; height: number } {
  return {
    pixels: Buffer.alloc(width * height * 3, 255).toString('base64'),
    width,
    height
  }
}

function tensor(values: number): { tensor: string } {
  return { tensor: Buffer.from(new Float32Array(values).fill(0.5).buffer).toString('base64') }
}

const BODY = { model: 'smolvla', images: [pixels(), pixels()], tokens: [7, 8, 9] }

function failedPaths(result: {
  success: boolean
  error?: { issues: Array<{ path: PropertyKey[] }> }
}): string[] {
  assert.equal(result.success, false)
  return result.error!.issues.map((i) => i.path.join('/'))
}

function httpCode(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof HttpError)
    return err.code
  }
  assert.fail('expected an HttpError')
}

describe('vlaActionsBody', () => {
  it('accepts pixel and tensor frames', () => {
    assert.equal(vlaActionsBody.safeParse(BODY).success, true)
    assert.equal(
      vlaActionsBody.safeParse({ ...BODY, images: [tensor(48), pixels()] }).success,
      true
    )
  })

  it('rejects a frame that is neither form, or is not base64', () => {
    assert.deepEqual(failedPaths(vlaActionsBody.safeParse({ ...BODY, images: [{}] })), ['images/0'])
    assert.deepEqual(
      failedPaths(vlaActionsBody.safeParse({ ...BODY, images: [{ tensor: '!!' }] })),
      ['images/0/tensor']
    )
  })

  it('requires tokens and rejects a mask that is not 0 or 1', () => {
    assert.deepEqual(failedPaths(vlaActionsBody.safeParse({ ...BODY, tokens: [] })), ['tokens'])
    assert.deepEqual(failedPaths(vlaActionsBody.safeParse({ ...BODY, attentionMask: [1, 2, 1] })), [
      'attentionMask/1'
    ])
  })

  it('rejects unknown fields', () => {
    assert.equal(vlaActionsBody.safeParse({ ...BODY, prompt: 'pick' }).success, false)
  })
})

describe('vlaEmbodimentBody', () => {
  it('accepts a tag, a cat_id or an object naming one of them', () => {
    for (const embodiment of [
      'libero_sim',
      3,
      { tag: 'real_droid', numCameras: 2 },
      { catId: 0 }
    ]) {
      assert.equal(vlaEmbodimentBody.safeParse({ embodiment }).success, true)
    }
  })

  it('rejects both or neither of tag and catId, and out-of-range ids', () => {
    for (const embodiment of [{ tag: 'a', catId: 1 }, { numCameras: 2 }, 32, -1, '']) {
      assert.equal(vlaEmbodimentBody.safeParse({ embodiment }).success, false, String(embodiment))
    }
  })
})

describe('buildRunParams', () => {
  it('preprocesses pixels and pads tokens, mask and state', () => {
    const params = buildRunParams(vlaActionsBody.parse({ ...BODY, state: [1, 2] }), HPARAMS)
    assert.equal(params.images.length, 2)
    assert.equal(params.images[0]!.length, 3 * SIZE * SIZE)
    assert.equal(params.imgWidth, SIZE)
    assert.deepEqual([...params.tokens], [7, 8, 9, 0, 0])
    assert.deepEqual([...params.mask], [1, 1, 1, 0, 0])
    assert.deepEqual([...params.state], [1, 2, 0, 0, 0, 0])
    assert.equal(params.noise, undefined)
  })

  it('passes a tensor through unchanged', () => {
    const body = vlaActionsBody.parse({ ...BODY, images: [tensor(48), tensor(48)] })
    const params = buildRunParams(body, HPARAMS)
    assert.ok(params.images[0]!.every((v) => v === 0.5))
  })

  it('keeps the mask the client sent', () => {
    const params = buildRunParams(
      vlaActionsBody.parse({ ...BODY, attentionMask: [1, 0, 1] }),
      HPARAMS
    )
    assert.deepEqual([...params.mask], [1, 0, 1, 0, 0])
  })

  it('sends an empty state to a discrete-state model', () => {
    const body = vlaActionsBody.parse({ ...BODY, state: [1, 2, 3, 4, 5, 6, 7, 8] })
    const params = buildRunParams(body, { ...HPARAMS, stateInputMode: 'discrete' })
    assert.equal(params.state.length, 0)
  })

  it('rejects inputs that do not match the model', () => {
    const parse = (extra: object) => vlaActionsBody.parse({ ...BODY, ...extra })
    assert.equal(
      httpCode(() => buildRunParams(parse({ images: [pixels()] }), HPARAMS)),
      'invalid_images'
    )
    assert.equal(
      httpCode(() =>
        buildRunParams(parse({ images: [pixels(), { ...pixels(), width: 3 }] }), HPARAMS)
      ),
      'invalid_images'
    )
    assert.equal(
      httpCode(() => buildRunParams(parse({ images: [tensor(47), pixels()] }), HPARAMS)),
      'invalid_images'
    )
    assert.equal(
      httpCode(() => buildRunParams(parse({ tokens: [1, 2, 3, 4, 5, 6] }), HPARAMS)),
      'invalid_tokens'
    )
    assert.equal(
      httpCode(() => buildRunParams(parse({ attentionMask: [1] }), HPARAMS)),
      'invalid_attention_mask'
    )
    assert.equal(
      httpCode(() => buildRunParams(parse({ state: [0, 0, 0, 0, 0, 0, 0] }), HPARAMS)),
      'invalid_state'
    )
    assert.equal(
      httpCode(() => buildRunParams(parse({ noise: [0] }), HPARAMS)),
      'invalid_noise'
    )
  })

  it('needs tensors and noise for a patch-input model', () => {
    const groot: VlaHparams = { ...HPARAMS, imageInputMode: 'patches', imagePatchElems: 10 }
    const parse = (extra: object) => vlaActionsBody.parse({ ...BODY, ...extra })
    assert.equal(
      httpCode(() => buildRunParams(parse({}), groot)),
      'invalid_images'
    )
    const tensors = { images: [tensor(10), tensor(10)] }
    assert.equal(
      httpCode(() => buildRunParams(parse(tensors), groot)),
      'invalid_noise'
    )
    const params = buildRunParams(parse({ ...tensors, noise: new Array(8).fill(0) }), groot)
    assert.equal(params.noise!.length, 8)
  })
})

describe('VLA error codes', () => {
  it('do not clash with another extension', () => {
    assert.doesNotThrow(() => extensionErrorCodes([openaiExtension, defaultExtension]))
    assert.equal(VLA_FIELD_CODES['tokens'], 'invalid_tokens')
  })
})
