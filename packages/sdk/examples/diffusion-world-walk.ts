import {
  loadModel,
  unloadModel,
  worldCreateScene,
  worldStep,
  ABOT_WORLD_0_5B_Q8_0,
  ABOT_WORLD_0_5B_LF_VAE,
  ABOT_WORLD_0_5B_LF_VAE_F16,
  UMT5_XXL_ENC_Q8_0
} from '@qvac/sdk'
import fs from 'fs'
import path from 'path'

// ABot-World interactive walk: create a world from a photo, then walk it.
//
// ABot-World is a causal world model (a Wan2.2-TI2V-5B derivative) — instead
// of generating a whole video from one call, each worldStep() denoises one
// block under the keys held during it, so the walk below is a scripted loop
// of steps (W = forward, L = look right, ...). Wants a dedicated GPU with
// >= 20 GB free VRAM at the native 832x480 (see the @qvac/diffusion-cpp
// ABot-World guide for the hardware tiers).
//
// Model-constant naming caveat (auto-derived from the registry file names):
// ABOT_WORLD_0_5B_LF_VAE is the taehv streaming pixel DECODER
// (taew2_2_f16.gguf) and ABOT_WORLD_0_5B_LF_VAE_F16 is the Wan 2.2 VAE
// first-frame ENCODER (wan2.2_vae_f16.gguf).
const firstFramePath = process.argv[2]
const prompt = process.argv[3] || 'a realistic outdoor scene with a navigable path'
const outputDir = process.argv[4] || '.'
const scenePack = path.resolve(outputDir, 'abot-scene.safetensors')

if (!firstFramePath) {
  console.error('✖ first-frame image path is required')
  console.error(
    'Usage: bun run bare:example dist/examples/diffusion-world-walk.js ' +
      '<firstFramePath> [prompt] [outputDir]'
  )
  process.exit(1)
}

// The walk tape: keys held for each generated block (~12 frames each).
const walkTape: ('W' | 'A' | 'S' | 'D' | 'I' | 'J' | 'K' | 'L')[][] = [
  ['W'],
  ['W'],
  ['W', 'L'],
  ['W'],
  []
]

try {
  console.log('▸ Loading the ABot-World walk session (DiT + taehv + scene encoders)...')
  const modelId = await loadModel({
    modelSrc: ABOT_WORLD_0_5B_Q8_0,
    modelType: 'sdcpp-generation',
    modelConfig: {
      mode: 'world',
      taehvModelSrc: ABOT_WORLD_0_5B_LF_VAE,
      t5XxlModelSrc: UMT5_XXL_ENC_Q8_0,
      vaeModelSrc: ABOT_WORLD_0_5B_LF_VAE_F16,
      world: {
        scenePack,
        seed: 42,
        kv_cache: true
      }
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  console.log(`▸ Creating the world from ${firstFramePath} ("${prompt}")...`)
  const scene = worldCreateScene({
    modelId,
    prompt,
    image: new Uint8Array(fs.readFileSync(firstFramePath))
  })
  const sceneStats = await scene.stats
  console.log(`▸ Scene pack written to ${scenePack} in ${sceneStats?.sceneCreateMs ?? '?'} ms`)

  let frameIndex = 0
  for (const keys of walkTape) {
    const { progressStream, frames } = worldStep({ modelId, keys })
    for await (const { step, frames: blockFrames, elapsedMs } of progressStream) {
      console.log(
        `▸ block ${step}: ${blockFrames} frames in ${elapsedMs} ms [${keys.join('+') || 'idle'}]`
      )
    }
    for (const frame of await frames) {
      const outputPath = path.join(outputDir, `walk_${String(frameIndex).padStart(4, '0')}.png`)
      fs.writeFileSync(outputPath, frame)
      frameIndex++
    }
  }
  console.log(`▸ Saved ${frameIndex} frames to ${outputDir}`)

  await unloadModel({ modelId, clearStorage: false })
  console.log('▸ Done')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
