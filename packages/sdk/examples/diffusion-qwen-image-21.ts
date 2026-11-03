import { close, diffusion, loadModel, unloadModel } from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

// Combine two reference images into an RGBA image with a transparent background.
// Use the pinned model revisions from the diffusion addon's Qwen-Image-2.1 downloader.
// Model terms: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/d26bb61231c349cf6b7896fa83353113880e1ba3/LICENSE

const HF = 'https://huggingface.co'
const encoderRepo = `${HF}/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/f982a07559d4a2f6c8744d840bf6fccab30eea96`
const referencePathA = process.argv[2]
const referencePathB = process.argv[3]
const prompt =
  process.argv[4] ||
  'Place the subjects from both reference images side by side. Generate an RGBA image with a transparent background and no scenery.'
const outputDir = process.argv[5] || '.'
const diffusionModelSrc =
  process.argv[6] ||
  `${HF}/leejet/Qwen-Image-2.1-GGUF/resolve/cc11433936a06e9765f7c0c0b1f0436cfd2b9856/qwen_image_2.1-Q4_K.gguf`
const llmModelSrc = process.argv[7] || `${encoderRepo}/Qwen3VL-8B-Instruct-Q4_K_M.gguf`
const vaeModelSrc =
  process.argv[8] ||
  `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/a8342359c61979b06a8dafb1a47991fe1f30e994/vae/qwen_image_2.1_vae_bf16.safetensors`
const projectionModelSrc = process.argv[9] || `${encoderRepo}/mmproj-Qwen3VL-8B-Instruct-F16.gguf`

const usage =
  'Usage: node --import tsx examples/diffusion-qwen-image-21.ts <referenceA> <referenceB> [prompt] [outputDir] [model] [llm] [vae] [projector]'

if (process.argv.includes('--help')) {
  console.log(usage)
  console.log(
    '▸ Defaults download pinned Hugging Face weights. Model overrides accept paths or URLs.'
  )
  console.log('▸ The default prompt combines both subjects on a transparent background.')
  process.exit(0)
}

if (!referencePathA || !referencePathB) {
  console.error('✖ two reference image paths are required')
  console.error(usage)
  process.exit(1)
}

function modelSource(source: string) {
  return /^https?:\/\//.test(source) ? source : path.resolve(source)
}

let modelId: string | undefined

try {
  const init_images = [referencePathA, referencePathB].map(
    (file) => new Uint8Array(fs.readFileSync(file))
  )

  console.log('▸ Loading Qwen-Image-2.1 split-layout model...')
  modelId = await loadModel({
    modelSrc: modelSource(diffusionModelSrc),
    modelType: 'sdcpp-generation',
    modelConfig: {
      llmModelSrc: modelSource(llmModelSrc),
      vaeModelSrc: modelSource(vaeModelSrc),
      projectionModelSrc: modelSource(projectionModelSrc),
      flash_attn: true
    },
    onProgress: (progress) => {
      const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
      const line = `▸ Downloading ${progress.percentage.toFixed(0)}% (${mb(progress.downloaded)}/${mb(progress.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (progress.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)
  console.log(`▸ Generating from "${referencePathA}" and "${referencePathB}": "${prompt}"`)

  const { progressStream, outputs, stats } = diffusion({
    modelId,
    prompt,
    init_images,
    width: 512,
    height: 512,
    steps: 30,
    cfg_scale: 6,
    sampling_method: 'euler',
    seed: 42
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  const buffers = await outputs
  if (buffers.length === 0) throw new Error('Qwen-Image-2.1 returned no image.')
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `qwen_image_21_${i}.png`)
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
