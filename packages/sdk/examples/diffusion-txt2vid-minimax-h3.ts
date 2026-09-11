import { loadModel, unloadModel, video } from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

// Pass a directory containing the four MiniMax-H3 files, followed by an output path.
const modelsDir = process.argv[2]
if (!modelsDir) {
  throw new Error('Usage: diffusion-txt2vid-minimax-h3.ts <models-directory> [output.avi]')
}
const outputPath = process.argv[3] || 'minimax-h3.avi'
const modelSrc = path.resolve(modelsDir, 'minimax_h3_fl2va_pruned-Q4_K.gguf')
const llmModelSrc = path.resolve(modelsDir, 'qwen3vl_32b_minimax_h3-Q4_K_M.gguf')
const vaeModelSrc = path.resolve(modelsDir, 'vae/minimax_h3_video_vae_fp16.safetensors')
const audioVaeModelSrc = path.resolve(modelsDir, 'vae/minimax_h3_audio_vae_fp32.safetensors')
for (const file of [modelSrc, llmModelSrc, vaeModelSrc, audioVaeModelSrc]) fs.accessSync(file)

let modelId: string | undefined
try {
  modelId = await loadModel({
    modelType: 'sdcpp-generation',
    modelSrc,
    modelConfig: {
      mode: 'video',
      llmModelSrc,
      vaeModelSrc,
      audioVaeModelSrc,
      device: 'gpu',
      diffusion_fa: true,
      offload_to_cpu: process.env['H3_OFFLOAD_TO_CPU'] !== '0',
      stream_layers: process.env['H3_STREAM_LAYERS'] === '1',
      ...(process.env['H3_BACKEND'] && { backend: process.env['H3_BACKEND'] }),
      ...(process.env['H3_PARAMS_BACKEND'] && { params_backend: process.env['H3_PARAMS_BACKEND'] }),
      ...(process.env['H3_MAX_VRAM'] && { max_vram: process.env['H3_MAX_VRAM'] })
    }
  })
  const { progressStream, outputs, stats } = video({
    modelId,
    mode: 'txt2vid',
    prompt:
      process.env['PROMPT'] ||
      'Premium cinematic coffee commercial. A confident adult sits at a small café table at sunrise, slowly lifts one matte black coffee cup, takes a relaxed sip, and smiles. Warm golden rim light, drifting steam, realistic skin, natural hands, shallow depth of field, subtle slow camera push-in, restrained natural motion, polished live-action advertising, no dialogue, no text overlay.',
    negative_prompt:
      'extra people, duplicate cup, malformed hands, cup fused to hand, text, subtitles, watermark, cartoon, CGI, blur, flicker, jitter, camera shake',
    width: 960,
    height: 544,
    // H3 uses 17*k+5 frames; 124 frames at 24 FPS is approximately 5.17 seconds.
    video_frames: Number(process.env['FRAMES'] || 124),
    fps: 24,
    steps: 8,
    cfg_scale: 1,
    seed: 11
  })
  const progress = (async () => {
    for await (const tick of progressStream) console.log(`Step ${tick.step}/${tick.totalSteps}`)
  })()
  const [buffers, runtimeStats] = await Promise.all([outputs, stats, progress])
  if (!buffers[0]) throw new Error('Generation finished without an AVI result')
  fs.writeFileSync(outputPath, buffers[0])
  console.log(`Saved ${outputPath}`, runtimeStats)
} finally {
  if (modelId) await unloadModel({ modelId, clearStorage: false })
}
process.exit(0)
