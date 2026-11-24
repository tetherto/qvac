import test from 'brittle'
import os from 'bare-os'
import type { DiffusionFitRequest } from '@qvac/diffusion-cpp'
import { sdcppConfigSchema } from '@/schemas'
import { sdcppFitRequest } from '@/plugins/builtin/sdcpp-generation/fit'
import { imageFilesFor } from '@/plugins/builtin/sdcpp-generation/load-files'
import { diffusion, markCoremlUnetModel } from '@/plugins/builtin/sdcpp-generation/ops/diffusion'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { ModelLoadFailedError, PluginRequestValidationFailedError } from '@/errors'

const SD21 =
  'registry://hf/gpustack/stable-diffusion-v2-1-GGUF/resolve/12ddc22724f6da35f0b6006e459fae66eaf56931/stable-diffusion-v2-1-Q8_0.gguf'
const BUNDLE_ROOT = 'registry://s3/qvac_models_compiled/ggml/stable-diffusion/2026-11-19/'
const UNET = `${BUNDLE_ROOT}sd21base_unet_p6.mlmodelc`
const TAE_DECODER = '/models/taesd_decoder.mlmodelc'
const TAESD = `${BUNDLE_ROOT}taesd.safetensors`

type DiffusionDebugModel = { _files?: Record<string, string | undefined> }

function resolveContext(platform?: 'darwin' | 'ios' | 'linux' | 'win32' | 'android') {
  const resolved: unknown[] = []
  return {
    resolved,
    ctx: {
      resolveModelPath: async (src: unknown) => {
        resolved.push(src)
        return `/cache/${String(src).replace(/\/+$/, '').split('/').pop()}`
      },
      modelSrc: SD21,
      modelType: 'sdcpp-generation',
      ...(platform !== undefined && { platform })
    }
  }
}

async function plugin() {
  return (await import('@/plugins/builtin/sdcpp-generation/plugin')).diffusionPlugin
}

test('sdcppConfigSchema: accepts the tiny autoencoder and Core ML sidecar sources', (t) => {
  const result = sdcppConfigSchema.safeParse({
    prediction: 'eps',
    taesdModelSrc: TAESD,
    coremlUnetModelSrc: UNET,
    coremlTaeDecoderModelSrc: { src: TAE_DECODER, name: 'taesd decoder' }
  })
  t.is(result.success, true)
})

test('sdcpp plugin resolveConfig: resolves the sidecars on Apple and strips the sources', async (t) => {
  const diffusionPlugin = await plugin()
  for (const platform of ['darwin', 'ios'] as const) {
    const { ctx, resolved } = resolveContext(platform)
    const result = await diffusionPlugin.resolveConfig!(
      {
        mode: 'diffusion',
        prediction: 'eps',
        taesdModelSrc: TAESD,
        coremlUnetModelSrc: UNET,
        coremlTaeDecoderModelSrc: TAE_DECODER
      },
      ctx
    )

    t.alike(result.artifacts, {
      taesdModelPath: '/cache/taesd.safetensors',
      coremlUnetModelPath: '/cache/sd21base_unet_p6.mlmodelc',
      coremlTaeDecoderModelPath: '/cache/taesd_decoder.mlmodelc'
    })
    t.alike(resolved, [TAESD, UNET, TAE_DECODER], `${platform}: each source resolves once`)
    for (const key of ['taesdModelSrc', 'coremlUnetModelSrc', 'coremlTaeDecoderModelSrc']) {
      t.absent(key in result.config, `${platform}: ${key} stays out of the engine config`)
    }
    t.is(result.config.prediction, 'eps', 'an explicit prediction is kept as given')
  }
})

test('sdcpp plugin resolveConfig: leaves prediction to the caller with a Core ML UNet', async (t) => {
  const diffusionPlugin = await plugin()
  const result = await diffusionPlugin.resolveConfig!(
    { mode: 'diffusion', coremlUnetModelSrc: UNET },
    resolveContext('darwin').ctx
  )
  t.absent('prediction' in result.config, 'the export, not the SDK, decides its prediction type')
})

test('sdcpp plugin resolveConfig: refuses Core ML sidecars off Apple before any download', async (t) => {
  const diffusionPlugin = await plugin()
  for (const platform of ['linux', 'win32', 'android'] as const) {
    for (const key of ['coremlUnetModelSrc', 'coremlTaeDecoderModelSrc'] as const) {
      const { ctx, resolved } = resolveContext(platform)
      const error = await diffusionPlugin.resolveConfig!(
        { mode: 'diffusion', taesdModelSrc: TAESD, [key]: UNET },
        ctx
      ).then(
        () => undefined,
        (err: unknown) => err
      )
      t.ok(error instanceof ModelLoadFailedError, `${platform} ${key}`)
      t.ok(
        new RegExp(`${key} is an Apple Core ML sidecar.*macOS and iOS only`).test(
          (error as Error).message
        ),
        `${platform} ${key}: names the platform rule`
      )
      t.is(resolved.length, 0, `${platform} ${key}: nothing is downloaded`)
    }
  }
})

test('sdcpp plugin resolveConfig: the tiny autoencoder alone loads on any platform', async (t) => {
  const diffusionPlugin = await plugin()
  const result = await diffusionPlugin.resolveConfig!(
    { mode: 'diffusion', taesdModelSrc: TAESD },
    resolveContext('linux').ctx
  )
  t.alike(result.artifacts, { taesdModelPath: '/cache/taesd.safetensors' })
})

test('sdcpp plugin resolveConfig: refuses the image-only sources in other modes', async (t) => {
  const diffusionPlugin = await plugin()
  for (const mode of ['video', 'upscale', 'world'] as const) {
    for (const key of ['taesdModelSrc', 'coremlUnetModelSrc', 'coremlTaeDecoderModelSrc']) {
      const { ctx, resolved } = resolveContext('darwin')
      const error = await diffusionPlugin.resolveConfig!(
        { mode, [key]: key === 'taesdModelSrc' ? TAESD : UNET },
        ctx
      ).then(
        () => undefined,
        (err: unknown) => err
      )
      t.ok(error instanceof ModelLoadFailedError, `${mode} ${key}`)
      t.ok(
        new RegExp(`${key} is image diffusion only`).test((error as Error).message),
        `${mode} ${key}: the image-only rule rejects it`
      )
      t.is(resolved.length, 0, `${mode} ${key}: nothing is downloaded`)
    }
  }
})

test('sdcpp plugin resolveConfig: a Core ML sidecar source must be able to deliver a directory', async (t) => {
  const diffusionPlugin = await plugin()
  const refused = [
    ['https://example.com/sdxs_unet_fp16.mlmodelc', /https:\/\/ source downloads a single file/],
    [
      `pear://${'a'.repeat(64)}/sdxs_unet_fp16.mlmodelc`,
      /pear:\/\/ source downloads a single file/
    ],
    [`${BUNDLE_ROOT}sdxs_unet_fp16.mlmodelc/weights/weight.bin`, /bundle directory.*not a file/],
    [
      { src: `${BUNDLE_ROOT}taesd.safetensors`, name: 'not a bundle' },
      /bundle directory.*not a file/
    ]
  ] as const
  for (const [src, message] of refused) {
    const { ctx, resolved } = resolveContext('darwin')
    const error = await diffusionPlugin.resolveConfig!(
      { mode: 'diffusion', coremlUnetModelSrc: src },
      ctx
    ).then(
      () => undefined,
      (err: unknown) => err
    )
    t.ok(error instanceof ModelLoadFailedError, JSON.stringify(src))
    t.ok(message.test((error as Error).message), `${JSON.stringify(src)}: ${String(error)}`)
    t.is(resolved.length, 0, 'nothing is downloaded')
  }

  for (const src of [`${BUNDLE_ROOT}sdxs_unet_fp16.mlmodelc/`, '/models/unet.mlpackage', 'unet']) {
    const { ctx } = resolveContext('darwin')
    const result = await diffusionPlugin.resolveConfig!(
      { mode: 'diffusion', coremlUnetModelSrc: src },
      ctx
    )
    t.ok(result.artifacts?.coremlUnetModelPath, `${src} resolves`)
  }
})

test('imageFilesFor: hands the sidecars and tiny autoencoder to the addon', (t) => {
  t.alike(
    imageFilesFor('/models/sd21.gguf', {
      taesdModelPath: '/models/taesd.safetensors',
      coremlUnetModelPath: '/models/unet.mlmodelc',
      coremlTaeDecoderModelPath: '/models/decoder.mlmodelc'
    }),
    {
      model: '/models/sd21.gguf',
      taesd: '/models/taesd.safetensors',
      coremlUnet: '/models/unet.mlmodelc',
      coremlTaeDecoder: '/models/decoder.mlmodelc'
    }
  )
})

test('sdcppFitRequest: a Core ML load is unknown without asking the fitter', (t) => {
  for (const artifacts of [
    { coremlUnetModelPath: '/models/unet.mlmodelc' },
    { coremlTaeDecoderModelPath: '/models/decoder.mlmodelc', taesdModelPath: '/models/taesd' }
  ]) {
    const plan = sdcppFitRequest({
      modelPath: '/models/sd21.gguf',
      modelConfig: { mode: 'diffusion' },
      artifacts,
      isShardedModel: false
    })
    t.ok('unknown' in plan, JSON.stringify(artifacts))
    t.ok('unknown' in plan && /Core ML/.test(plan.unknown))
  }
})

test('sdcppFitRequest: the tiny autoencoder alone is sized by the fitter', (t) => {
  const plan = sdcppFitRequest({
    modelPath: '/models/sd21.gguf',
    modelConfig: { mode: 'diffusion' },
    artifacts: { taesdModelPath: '/models/taesd.safetensors' },
    isShardedModel: false
  })
  const request = 'request' in plan ? (plan.request as DiffusionFitRequest) : undefined
  t.alike(request?.files, { model: '/models/sd21.gguf', taesd: '/models/taesd.safetensors' })
})

test('sdcpp plugin createModel: wires the sidecars into the addon on Apple', async (t) => {
  // The addon refuses Core ML files on any other host when it is constructed.
  if (os.platform() !== 'darwin' && os.platform() !== 'ios') {
    t.comment(`skipped on ${os.platform()}: the addon accepts Core ML files on Apple only`)
    t.pass()
    return
  }
  const diffusionPlugin = await plugin()
  const result = diffusionPlugin.createModel({
    modelId: 'sd21-coreml-test',
    modelPath: '/tmp/stable-diffusion-v2-1-Q8_0.gguf',
    modelConfig: { mode: 'diffusion', prediction: 'eps' },
    artifacts: {
      taesdModelPath: '/tmp/taesd.safetensors',
      coremlUnetModelPath: '/tmp/sd21base_unet_p6.mlmodelc',
      coremlTaeDecoderModelPath: '/tmp/taesd_decoder.mlmodelc'
    }
  })
  const files = (result.model as unknown as DiffusionDebugModel)._files ?? {}
  t.is(files['taesd'], '/tmp/taesd.safetensors')
  t.is(files['coremlUnet'], '/tmp/sd21base_unet_p6.mlmodelc')
  t.is(files['coremlTaeDecoder'], '/tmp/taesd_decoder.mlmodelc')
})

test('diffusion: a Core ML UNet model refuses a LoRA before the native call', async (t) => {
  const modelId = 'diffusion-coreml-lora'
  let runs = 0
  const model = {
    cancel: async () => {},
    run: async () => {
      runs++
      return { iterate: async function* () {}, await: async () => {} }
    }
  }
  markCoremlUnetModel(model as never)
  registerModel(modelId, {
    model: model as never,
    path: '/models/sd21.gguf',
    config: {},
    modelType: 'sdcpp-generation'
  })
  try {
    const stream = diffusion({ modelId, prompt: 'A fox.', lora: '/models/style.safetensors' })
    const error = await stream.next().then(
      () => undefined,
      (err: unknown) => err
    )
    t.ok(error instanceof PluginRequestValidationFailedError)
    t.ok(/lora is not supported with a Core ML UNet/.test((error as Error).message))
    t.is(runs, 0, 'the request never reaches the engine')

    const plain = diffusion({ modelId, prompt: 'A fox.' })
    while (!(await plain.next()).done);
    t.is(runs, 1, 'a request without a LoRA runs')
  } finally {
    unregisterModel(modelId)
  }
})
