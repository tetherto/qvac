import { close, diffusion, loadModel, unloadModel } from '@qvac/sdk'
import fs from 'fs'
import path from 'path'
import { parseArgs } from 'util'

// Stable Diffusion with its UNet and tiny-autoencoder decoder on Apple Core ML
// (macOS and iOS). Text encoding and sampling stay on the diffusion engine.
//
// SD 2.1 with the SD 2.1-base UNet sidecar and the TAESD decoder:
//   npx tsx examples/diffusion-coreml.ts --model stable-diffusion-v2-1-Q8_0.gguf \
//     --unet sd21base_unet_p6.mlmodelc --taesd taesd.safetensors \
//     --decoder taesd_decoder.mlmodelc --prediction eps
//
// SDXS has a tiny autoencoder built in, so it needs no --taesd. It is a one-step model:
//   npx tsx examples/diffusion-coreml.ts --model sdxs.gguf --unet sdxs_unet_fp16.mlmodelc \
//     --decoder sdxs_tae_decoder.mlmodelc --steps 1 --cfg 1
//
// Sidecars are compiled .mlmodelc directories, local or `registry://` addresses.

const usage =
  'Usage: npx tsx examples/diffusion-coreml.ts --model <gguf> --unet <unet.mlmodelc> ' +
  '[--decoder <decoder.mlmodelc>] [--taesd <taesd.safetensors>] [--prediction eps|v] ' +
  '[--steps 20] [--cfg 7] [--size 512] [--out .] [prompt]'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    unet: { type: 'string' },
    decoder: { type: 'string' },
    taesd: { type: 'string' },
    prediction: { type: 'string' },
    steps: { type: 'string', default: '20' },
    cfg: { type: 'string', default: '7' },
    size: { type: 'string', default: '512' },
    out: { type: 'string', default: '.' },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log(usage)
  process.exit(0)
}
if (!values.model || !values.unet) {
  console.error('✖ --model and --unet are required')
  console.error(usage)
  process.exit(1)
}
if (values.prediction !== undefined && values.prediction !== 'eps' && values.prediction !== 'v') {
  console.error(`✖ --prediction must be eps or v, got: ${values.prediction}`)
  process.exit(1)
}
if (process.platform !== 'darwin') {
  console.error('✖ Core ML sidecars load on macOS and iOS only')
  process.exit(1)
}

// The export fixes the image size, so generate at the size it was exported for.
const size = Number(values.size)
const prompt = positionals.join(' ') || 'a red fox in a snowy forest'

// Local paths become absolute; registry:// and URL sources pass through.
function source(src: string) {
  return /^[a-z]+:\/\//.test(src) ? src : path.resolve(src)
}

let modelId: string | undefined

try {
  console.log('▸ Loading the model with its Core ML sidecars...')
  modelId = await loadModel({
    modelSrc: source(values.model),
    modelType: 'sdcpp-generation',
    modelConfig: {
      coremlUnetModelSrc: source(values.unet),
      ...(values.decoder !== undefined && { coremlTaeDecoderModelSrc: source(values.decoder) }),
      ...(values.taesd !== undefined && { taesdModelSrc: source(values.taesd) }),
      ...(values.prediction !== undefined && { prediction: values.prediction })
    },
    onProgress: (progress) => {
      const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
      const line = `▸ Downloading ${progress.percentage.toFixed(0)}% (${mb(progress.downloaded)}/${mb(progress.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (progress.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)
  console.log(`▸ Generating: "${prompt}"`)

  const { outputs, stats } = diffusion({
    modelId,
    prompt,
    width: size,
    height: size,
    steps: Number(values.steps),
    cfgScale: Number(values.cfg),
    seed: 42
  })

  const buffers = await outputs
  if (buffers.length === 0) throw new Error('The model returned no image.')
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(values.out, `coreml_${i}.png`)
    fs.writeFileSync(outputPath, buffers[i]!)
    console.log(`▸ Saved ${outputPath}`)
  }

  console.log('▸ Stats:', await stats)
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  try {
    if (modelId) await unloadModel({ modelId, clearStorage: false })
  } catch (error) {
    console.error('✖ Unload failed:', error)
    process.exitCode = 1
  }
  try {
    await close()
  } catch (error) {
    console.error('✖ Cleanup failed:', error)
    process.exitCode = 1
  }
}

if (!process.exitCode) console.log('▸ Done')
