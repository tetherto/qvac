import {
  EmbedFailedError,
  InferenceCancelledError,
  RequestRejectedByPolicyError
} from '@/errors/index'
import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Buffer from 'bare-buffer'
import { embedRequestSchema, embedParamsSchema } from '@/schemas/embed'
import { embedConfigBaseSchema, embedConfigSchema } from '@/schemas/llamacpp-config'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'
import { embed, markEmbeddingProjector } from '@/plugins/ops/embed'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { ModelType } from '@/schemas/index'
import { createFitRequest } from '@/model-fit/request/create'
import { createErrorResponse } from '@/schemas/error'
import { ERROR_CODES } from '@/schemas/errors'

const media = { type: 'base64' as const, value: 'AQID' }

test('embed inputs: wire round-trip keeps ordered text, images and audio', (t) => {
  const request = {
    type: 'embed',
    modelId: 'model',
    requestId: 'request',
    inputs: [
      'query',
      ['title: none | text: ', { media }, 'suffix'],
      [{ media: { type: 'filePath', value: '/audio.wav' } }]
    ]
  }
  t.alike(embedRequestSchema.parse(request), request)
})

test('embed inputs: rejects ambiguous, empty and malformed requests', (t) => {
  for (const input of [
    {},
    { text: 'hello', inputs: ['hello'] },
    { inputs: [] },
    { inputs: [[]] },
    { inputs: [''] },
    { inputs: [[{ media: { type: 'base64', value: '!' } }]] },
    { inputs: [[{ media: { type: 'filePath', value: '' } }]] },
    { inputs: [[{ media: { type: 'url', value: 'https://example.com/image' } }]] }
  ]) {
    t.absent(embedParamsSchema.safeParse({ modelId: 'model', ...input }).success)
  }
  t.ok(embedParamsSchema.safeParse({ modelId: 'model', inputs: [['', { media }]] }).success)
})

test('embed inputs: reads base64 and files without changing input order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-embed-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'image.bmp')
  fs.writeFileSync(file, Buffer.from([4, 5, 6]))
  let received: unknown
  let runs = 0
  const modelId = install(async (input) => {
    received = input
    runs++
    return { await: async () => [[new Float32Array([0, 1]), new Float32Array([0, 1])]] }
  })
  t.teardown(() => unregisterModel(modelId))
  await embed(
    {
      modelId,
      inputs: [
        'query',
        ['prefix', { media }, { media: { type: 'filePath', value: file } }, 'suffix']
      ]
    },
    'prepare-media'
  )
  t.alike(
    JSON.parse(JSON.stringify(received)),
    JSON.parse(
      JSON.stringify({
        inputs: [
          'query',
          ['prefix', { media: Buffer.from([1, 2, 3]) }, { media: Buffer.from([4, 5, 6]) }, 'suffix']
        ]
      })
    )
  )
  await t.exception(
    embed({
      modelId,
      inputs: [[{ media: { type: 'filePath', value: path.join(dir, 'missing') } }]]
    }),
    /Unable to read embedding media/
  )
  getRequestRegistry().cancel({ requestId: 'cancel-before-media' })
  await t.exception(embed({ modelId, inputs: ['query'] }, 'cancel-before-media'), /cancel/i)
  t.is(runs, 1)
  t.is(getRequestRegistry().list().length, 0)
})

test('embed config: projector settings and context size reach the addon', (t) => {
  const config = embedConfigSchema.parse({
    ctxSize: 2048,
    imageMaxTokens: 280,
    imageMinTokens: 70,
    mmprojNoAudio: false,
    mmprojUseGpu: false,
    imageMaxMegapixels: 20,
    audioMaxSeconds: 60
  })
  const mapped = transformEmbedConfig(config)
  t.is(mapped.ctx_size, '2048')
  t.is(mapped['image-max-tokens'], '280')
  t.is(mapped['image-min-tokens'], '70')
  t.is(mapped['mmproj-no-audio'], '0')
  t.is(mapped['mmproj-use-gpu'], '0')
  t.is(mapped['image-max-megapixels'], '20')
  t.is(mapped['audio-max-seconds'], '60')
  for (const key of [
    'ctxSize',
    'imageMaxTokens',
    'imageMinTokens',
    'imageMaxMegapixels',
    'audioMaxSeconds'
  ]) {
    for (const value of [0, -1, 1.5]) {
      t.absent(embedConfigBaseSchema.safeParse({ [key]: value }).success)
    }
  }
})

test('embed fit: refuses a projector rather than reporting text-only memory', (t) => {
  t.alike(
    createFitRequest({
      modelType: ModelType.llamacppEmbedding,
      modelPath: '/model.gguf',
      modelConfig: {},
      artifacts: { projectionModelPath: '/mmproj.gguf' },
      isShardedModel: false
    }),
    { supported: false, detail: 'multimodal projection loads are not representable' }
  )
})

let nextId = 0
function install(
  run: (input: unknown) => Promise<unknown>,
  cancel = async () => {},
  hasProjector = true
) {
  const modelId = `embed-multimodal-test-${++nextId}`
  const model = { run, addon: { cancel } } as unknown as AnyModel
  if (hasProjector) markEmbeddingProjector(model)
  registerModel(modelId, {
    model,
    modelType: ModelType.llamacppEmbedding,
    path: '/model.gguf',
    config: {}
  })
  return modelId
}

test('embed op: mixed inputs return one normalized vector per input and retain stats', async (t) => {
  let received: unknown
  const modelId = install(async (input) => {
    received = input
    return {
      await: async () => [[new Float32Array([3, 4]), new Float32Array([0, 2])]],
      stats: { total_tokens: 12, context_size: 2048 }
    }
  })
  t.teardown(() => unregisterModel(modelId))
  const result = await embed({ modelId, inputs: ['query', [{ media }]] }, 'mixed-request')
  t.alike(received, { inputs: ['query', [{ media: Buffer.from([1, 2, 3]) }]] })
  t.ok(Math.abs((result.embedding as number[][])[0][0] - 0.6) < 1e-6)
  t.alike((result.embedding as number[][])[1], [0, 1])
  t.is(result.stats?.totalTokens, 12)
  t.is(result.stats?.contextSize, 2048)
  t.is(getRequestRegistry().list().length, 0)
})

test('embed op: one inputs item stays a batch, legacy text stays a single vector', async (t) => {
  const modelId = install(
    async () => ({ await: async () => [[new Float32Array([0, 1])]] }),
    async () => {},
    false
  )
  t.teardown(() => unregisterModel(modelId))
  t.alike((await embed({ modelId, inputs: ['query'] })).embedding, [[0, 1]])
  t.alike((await embed({ modelId, inputs: [['qu', 'ery']] })).embedding, [[0, 1]])
  t.alike((await embed({ modelId, text: 'query' })).embedding, [0, 1])
  t.alike((await embed({ modelId, text: ['query'] })).embedding, [[0, 1]])
})

test('embed op: media without a projector fails before preparation or native work', async (t) => {
  let runs = 0
  let reads = 0
  let decodes = 0
  let cancels = 0
  const modelId = install(
    async () => {
      runs++
      throw new Error('Media without a projector must not reach the addon')
    },
    async () => {
      cancels++
    },
    false
  )
  const readFile = fs.promises.readFile
  const from = Buffer.from
  t.teardown(() => {
    fs.promises.readFile = readFile
    Buffer.from = from
    unregisterModel(modelId)
  })
  fs.promises.readFile = async () => {
    reads++
    throw new Error('Media without a projector must not be read')
  }
  Buffer.from = ((...args: unknown[]) => {
    if (args[0] === media.value && args[1] === 'base64') decodes++
    return Reflect.apply(from, Buffer, args)
  }) as typeof Buffer.from

  for (const source of [media, { type: 'filePath' as const, value: '/missing-media.wav' }]) {
    try {
      await embed({ modelId, inputs: ['query', ['', { media: source }]] })
      t.fail('Media without a projector must reject')
    } catch (error) {
      t.ok(error instanceof EmbedFailedError)
      const response = createErrorResponse(error)
      t.is(response.code, ERROR_CODES.EMBED_FAILED)
      t.is(response.name, 'EMBED_FAILED')
      t.ok(response.message.includes('modelConfig.projectionModelSrc'))
    }
    t.is(getRequestRegistry().list().length, 0)
  }
  t.is(reads, 0)
  t.is(decodes, 0)
  t.is(runs, 0)
  t.is(cancels, 0)
})

test('embed op: missing vectors fail and release the request', async (t) => {
  const modelId = install(async () => ({ await: async () => [[]] }))
  t.teardown(() => unregisterModel(modelId))
  await t.exception(embed({ modelId, inputs: ['query'] }), /embedding/i)
  t.is(getRequestRegistry().list().length, 0)
})

test('embed op: accepted cancellation classifies native rejections and preserves the cause', async (t) => {
  const nativeError = new Error('Job cancelled')
  const modelId = install(async () => ({
    await: async () => {
      getRequestRegistry().cancel({ requestId: 'cancel-native-embed' })
      throw nativeError
    }
  }))
  t.teardown(() => unregisterModel(modelId))
  try {
    await embed({ modelId, inputs: [[{ media }]] }, 'cancel-native-embed')
    t.fail('Cancelled inference must reject')
  } catch (error) {
    t.ok(error instanceof InferenceCancelledError)
    t.is((error as Error).cause, nativeError)
  }
  t.is(getRequestRegistry().list().length, 0)
})

test('embed op: cancellation during a failed media read preserves the cause', async (t) => {
  const requestId = 'cancel-media-read'
  const readError = new Error('EIO: media read failed')
  let ran = false
  let cancelled = 0
  const modelId = install(
    async () => {
      ran = true
      throw new Error('Inference must not run after media preparation fails')
    },
    async () => {
      cancelled++
    }
  )
  const readFile = fs.promises.readFile
  t.teardown(() => {
    fs.promises.readFile = readFile
    unregisterModel(modelId)
  })
  fs.promises.readFile = async () => {
    t.is(getRequestRegistry().cancel({ requestId }), 1)
    throw readError
  }

  try {
    await embed(
      {
        modelId,
        inputs: [[{ media: { type: 'filePath', value: '/media.wav' } }]]
      },
      requestId
    )
    t.fail('Cancelled media preparation must reject')
  } catch (error) {
    t.ok(error instanceof InferenceCancelledError)
    t.is((error as Error).cause, readError)
  }
  t.absent(ran)
  t.is(cancelled, 0, 'media preparation has no native job to cancel')
  t.is(getRequestRegistry().list().length, 0)
})

test('embed op: overlapping and pre-cancelled calls leave the active model alone', async (t) => {
  let cancelled = 0
  const modelId = install(
    async () => {
      throw new Error('Overlapping requests must not run')
    },
    async () => {
      cancelled++
    }
  )
  t.teardown(() => unregisterModel(modelId))
  const registry = getRequestRegistry()
  await using active = await registry.begin({
    requestId: 'embed-holder',
    kind: 'embeddings',
    modelId
  })
  const request = {
    modelId,
    inputs: [[{ media: { type: 'filePath' as const, value: '/missing-overlap-media.wav' } }]]
  }
  await t.exception(
    () => embed(request),
    RequestRejectedByPolicyError as unknown as new () => Error
  )
  registry.cancel({ requestId: 'embed-pre-cancelled' })
  await t.exception(
    () => embed(request, 'embed-pre-cancelled'),
    InferenceCancelledError as unknown as new () => Error
  )
  t.is(cancelled, 0)
  t.absent(active.signal.aborted)
})

test('embed op: retains admission until native cancellation settles', async (t) => {
  const requestId = 'embed-pending-cancel'
  let finishCancel: () => void = () => {}
  const cancellation = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  let notifyCancel: () => void = () => {}
  const cancelStarted = new Promise<void>((resolve) => {
    notifyCancel = resolve
  })
  let runs = 0
  const modelId = install(
    async () => {
      const first = ++runs === 1
      return {
        await: async () => {
          if (first) getRequestRegistry().cancel({ requestId })
          return [[new Float32Array([0, 1])]]
        }
      }
    },
    async () => {
      notifyCancel()
      await cancellation
    }
  )
  t.teardown(() => unregisterModel(modelId))
  const first = embed({ modelId, text: 'first' }, requestId).catch((error: unknown) => error)
  await cancelStarted
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  await t.exception(
    () => embed({ modelId, text: 'overlap' }),
    RequestRejectedByPolicyError as unknown as new () => Error
  )
  finishCancel()
  t.ok((await first) instanceof InferenceCancelledError)
  t.alike((await embed({ modelId, text: 'recovery' })).embedding, [0, 1])
})
