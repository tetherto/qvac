import {
  close,
  diffusion,
  loadModel,
  unloadModel,
  MOSS_IMAGE_SFT_5B_BF16,
  MOSS_IMAGE_SFT_TOKENIZER,
  MOSS_IMAGE_VAE,
  QWEN3_5_9B_MULTIMODAL_Q4_K_M
} from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

// Generate a poster from a MOSS-Image JSON layout prompt.
// Model terms (Apache-2.0): https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT

const outputDir = process.argv[2] || '.'
const diffusionModelSrc = modelSource(process.argv[3]) || MOSS_IMAGE_SFT_5B_BF16
const llmModelSrc = modelSource(process.argv[4]) || QWEN3_5_9B_MULTIMODAL_Q4_K_M
const vaeModelSrc = modelSource(process.argv[5]) || MOSS_IMAGE_VAE
const tokenizerSrc = modelSource(process.argv[6]) || MOSS_IMAGE_SFT_TOKENIZER

const usage =
  'Usage: node --import tsx examples/diffusion-moss-image.ts [outputDir] [model] [llm] [vae] [tokenizer]'

if (process.argv.includes('--help')) {
  console.log(usage)
  console.log(
    '▸ Defaults download the MOSS-Image registry models. Model overrides accept paths or URLs.'
  )
  process.exit(0)
}

const width = 1024
const height = 1024

// Boxes are [y_min, x_min, y_max, x_max] in absolute pixels with the canvas
// centre as the origin, so a 1024×1024 canvas spans -512..512 on both axes.
// Keep them consistent with width and height.
const layout = {
  summary: {
    meta: ['poster'],
    canvas: 'single',
    caption: 'A minimalist travel poster of a snowy mountain at sunrise, flat illustration style.'
  },
  items: [
    {
      label: 'text',
      caption: 'Bold white sans-serif title across the top of the poster.',
      text: 'SUMMIT',
      bbox: [-448, -352, -320, 352]
    },
    {
      label: 'object',
      caption: 'A snowy mountain peak lit by an orange sunrise.',
      bbox: [-224, -320, 384, 320]
    }
  ],
  bbox_coord_space: 'abs_centralized',
  bbox_format: 'yxyx'
}

function modelSource(source: string | undefined) {
  if (!source) return undefined
  return /^https?:\/\//.test(source) ? source : path.resolve(source)
}

let modelId: string | undefined
// Progress fires many times per percent on a multi-GB download; write once per whole percent
// of each file.
const lastPercent = new Map<string, number>()

try {
  console.log('▸ Loading MOSS-Image...')
  modelId = await loadModel({
    modelSrc: diffusionModelSrc,
    modelType: 'sdcpp-generation',
    modelConfig: {
      llmModelSrc,
      vaeModelSrc,
      tokenizerSrc,
      flash_attn: true
    },
    onProgress: (progress) => {
      const percent = Math.floor(progress.percentage)
      if (lastPercent.get(progress.downloadKey) === percent) return
      lastPercent.set(progress.downloadKey, percent)
      const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
      const line = `▸ Downloading ${progress.percentage.toFixed(0)}% (${mb(progress.downloaded)}/${mb(progress.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (progress.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const { progressStream, outputs, stats } = diffusion({
    modelId,
    prompt: JSON.stringify(layout),
    width,
    height,
    steps: 50,
    cfg_scale: 3,
    sampling_method: 'euler',
    scheduler: 'discrete',
    seed: 42
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  const buffers = await outputs
  if (buffers.length === 0) throw new Error('MOSS-Image returned no image.')
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `moss_image_${i}.png`)
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
