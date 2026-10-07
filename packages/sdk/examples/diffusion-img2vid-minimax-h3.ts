import { loadModel, unloadModel, video } from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

const modelsDir = process.argv[2]
const initImagePath = process.argv[3]
if (!modelsDir || !initImagePath) {
  console.error('✖ models directory and init image path are required')
  console.error(
    'Usage: bun run bare:example dist/examples/diffusion-img2vid-minimax-h3.js ' +
      '<modelsDirectory> <initImagePath> [output.avi]'
  )
  process.exit(1)
}

const outputPath = process.argv[4] || 'minimax-h3-img2vid.avi'
const modelSrc = path.resolve(
  modelsDir,
  process.env['H3_MODEL'] || 'minimax_h3_fl2va_pruned-Q4_K.gguf'
)
const llmModelSrc = path.resolve(
  modelsDir,
  process.env['H3_LLM'] || 'qwen3vl_32b_minimax_h3-Q4_K_M.gguf'
)
const vaeModelSrc = path.resolve(modelsDir, 'vae/minimax_h3_video_vae_fp16.safetensors')

let modelId: string | undefined
try {
  for (const file of [modelSrc, llmModelSrc, vaeModelSrc, initImagePath]) fs.accessSync(file)

  console.log('▸ Loading MiniMax-H3 model (diffusion + Qwen3-VL + video VAE)...')
  modelId = await loadModel({
    modelType: 'sdcpp-generation',
    modelSrc,
    modelConfig: {
      mode: 'video',
      llmModelSrc,
      vaeModelSrc,
      device: 'gpu',
      diffusion_fa: true,
      offload_to_cpu: process.env['H3_OFFLOAD_TO_CPU'] !== '0',
      stream_layers: process.env['H3_STREAM_LAYERS'] === '1',
      ...(process.env['H3_BACKEND'] && { backend: process.env['H3_BACKEND'] }),
      ...(process.env['H3_PARAMS_BACKEND'] && { params_backend: process.env['H3_PARAMS_BACKEND'] }),
      ...(process.env['H3_MAX_VRAM'] && { max_vram: process.env['H3_MAX_VRAM'] })
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const init_image = new Uint8Array(fs.readFileSync(initImagePath))
  const prompt =
    process.env['PROMPT'] ||
    'The boat glides forward through the mist while the camera slowly pulls back, cinematic natural motion.'
  console.log(`▸ Generating video for: "${prompt}"`)

  const { progressStream, outputs, stats } = video({
    modelId,
    mode: 'img2vid',
    prompt,
    init_image,
    width: 960,
    height: 544,
    // H3 uses 17*k+5 frames and requires 24 FPS.
    video_frames: Number(process.env['FRAMES'] || 124),
    fps: 24,
    steps: 8,
    cfg_scale: 1,
    seed: 11
  })

  for await (const { step, totalSteps } of progressStream) {
    console.log(`▸ step ${step}/${totalSteps}`)
  }

  const buffers = await outputs
  if (!buffers[0]) throw new Error('Generation finished without an AVI result')
  fs.writeFileSync(outputPath, buffers[0])
  console.log(`▸ Saved ${outputPath}`, await stats)
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  if (modelId) await unloadModel({ modelId, clearStorage: false })
}
