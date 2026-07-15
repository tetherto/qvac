import { diffusion, loadModel, unloadModel } from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

const diffusionModelSrc =
  process.argv[2] ||
  'https://huggingface.co/leejet/ideogram-4-GGUF/resolve/main/ideogram4-Q4_0.gguf'
const uncondModelSrc =
  process.argv[3] ||
  'https://huggingface.co/leejet/ideogram-4-GGUF/resolve/main/ideogram4_uncond-Q4_0.gguf'
const llmModelSrc =
  process.argv[4] ||
  'https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3-VL-8B-Instruct-Q4_K_M.gguf'
const vaeModelSrc =
  process.argv[5] ||
  'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors'
const outputDir = process.argv[6] || '.'

function formatMb(bytes: number) {
  return (bytes / 1e6).toFixed(1)
}

// Ideogram 4 expects a JSON-serialized structured caption with explicit
// bounding boxes. Plain-text prompts produce degenerate or placeholder output.
const structuredPrompt = {
  high_level_description:
    'A bright product photo of one yellow coffee mug on a clean office desk with a tiny readable label that says IDEO.',
  style_description: {
    aesthetics: 'simple product photography, clean bright office desk, minimal composition',
    lighting: 'soft studio light with gentle shadows',
    photo: 'sharp focus, crisp readable label text',
    medium: 'product photo',
    color_palette: ['#FFD54A', '#FFFFFF', '#111111', '#7EC8E3']
  },
  compositional_deconstruction: {
    canvas: 'Square canvas, upright orientation. All text is horizontal and readable.',
    background: 'Clean white office desk with a soft blue background gradient.',
    elements: [
      {
        type: 'obj',
        bbox: [230, 260, 800, 740],
        desc: 'Exactly one matte yellow ceramic coffee mug centered on the desk.'
      },
      {
        type: 'text',
        bbox: [510, 360, 620, 640],
        text: 'IDEO',
        desc: 'Small black label printed horizontally on the mug.'
      }
    ]
  }
}

if (process.argv.includes('--help')) {
  console.log('Usage: tsx examples/diffusion-ideogram.ts [model] [uncond] [llm] [vae] [output-dir]')
  console.log('▸ Defaults use the four Hugging Face model URLs supported by the diffusion addon.')
  process.exit(0)
}

let modelId: string | undefined

try {
  console.log('▸ Loading Ideogram 4 split-layout model...')
  modelId = await loadModel({
    modelSrc: diffusionModelSrc,
    modelType: 'sdcpp-generation',
    modelConfig: {
      device: 'gpu',
      threads: 4,
      diffusion_fa: true,
      offload_to_cpu: true,
      llmModelSrc,
      vaeModelSrc,
      uncondModelSrc
    },
    onProgress: (progress) => {
      const line = `▸ Downloading ${progress.percentage.toFixed(0)}% (${formatMb(progress.downloaded)}/${formatMb(progress.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (progress.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const { progressStream, outputs, stats } = diffusion({
    modelId,
    prompt: JSON.stringify(structuredPrompt),
    width: 768,
    height: 768,
    steps: 16,
    cfg_scale: 7,
    seed: 42
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  const buffers = await outputs
  for (let i = 0; i < buffers.length; i++) {
    const outputPath = path.join(outputDir, `ideogram_${i}.png`)
    fs.writeFileSync(outputPath, buffers[i]!)
    console.log(`▸ Saved ${outputPath}`)
  }

  console.log('▸ Stats:', await stats)
  await unloadModel({ modelId, clearStorage: false })
  modelId = undefined
  console.log('▸ Done')
  process.exit(0)
} catch (error) {
  if (modelId) {
    try {
      await unloadModel({ modelId, clearStorage: false })
    } catch {
      // Preserve the original error.
    }
  }
  console.error('✖', error)
  process.exit(1)
}
