import { close, diffusion, loadModel, unloadModel } from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

// FLUX.3 Image Klein text-to-image, or reference editing when reference images are passed.
// FLUX.3 pairs its diffusion model with a Qwen3-VL 4B text encoder and the FLUX.2 VAE.
// Defaults download pinned Hugging Face weights; overrides accept paths or URLs.
// FLUX.3 model terms: https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/09561231f44e41381c461caf53d5452005a60ac9/LICENSE.md

const HF = 'https://huggingface.co'
const prompt = process.argv[2] || "A lovely cat holding a sign that says 'FLUX3'"
const outputDir = process.argv[3] || '.'
const diffusionModelSrc =
  process.argv[4] ||
  `${HF}/leejet/flux-3-image-klein-GGUF/resolve/1c2ad2f9b9247ccca6506a23bdb033fdb0873321/flux3-image-klein-Q8_0.gguf`
const llmModelSrc =
  process.argv[5] ||
  `${HF}/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf`
const vaeModelSrc =
  process.argv[6] ||
  `${HF}/Comfy-Org/Flux-2-Klein-4B/resolve/5b3abca5c0dc1ecd4eaf3340868d09063fc1c965/split_files/vae/flux2-vae.safetensors`
const referencePaths = process.argv.slice(7)

const usage =
  'Usage: node --import tsx examples/diffusion-flux3-klein.ts [prompt] [outputDir] [model] [llm] [vae] [...references]'

if (process.argv.includes('--help')) {
  console.log(usage)
  console.log(
    '▸ Defaults download pinned Hugging Face weights. Model overrides accept paths or URLs.'
  )
  console.log('▸ Pass up to 10 reference image paths to edit them instead of generating from text.')
  process.exit(0)
}

if (referencePaths.length > 10) {
  console.error('✖ FLUX.3 accepts at most 10 reference images')
  console.error(usage)
  process.exit(1)
}

function modelSource(source: string) {
  return /^https?:\/\//.test(source) ? source : path.resolve(source)
}

let modelId: string | undefined

try {
  const init_images = referencePaths.map((file) => new Uint8Array(fs.readFileSync(file)))

  console.log('▸ Loading FLUX.3 Image Klein split-layout model...')
  modelId = await loadModel({
    modelSrc: modelSource(diffusionModelSrc),
    modelType: 'sdcpp-generation',
    modelConfig: {
      llmModelSrc: modelSource(llmModelSrc),
      vaeModelSrc: modelSource(vaeModelSrc),
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
  console.log(`▸ Generating: "${prompt}"`)

  // Recommended settings for the distilled model: 16 Euler steps at CFG 1.
  const { progressStream, outputs, stats } = diffusion({
    modelId,
    prompt,
    ...(init_images.length > 0 && { init_images }),
    width: 512,
    height: 512,
    steps: 16,
    cfg_scale: 1,
    sampling_method: 'euler',
    seed: 42
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  const buffers = await outputs
  if (buffers.length === 0) throw new Error('FLUX.3 returned no image.')
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `flux3_${i}.png`)
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
