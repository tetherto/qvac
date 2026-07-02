// Image generation with stable-diffusion.cpp. Writes output.png.
//
// Run: bare examples/diffusion.ts ["a prompt"]
// Requires: npm install @qvac/core @qvac/diffusion-cpp

import fs from 'bare-fs'
import { registerPlugin, loadModel, diffusion, unloadModel, SD_V2_1_1B_Q8_0 } from '@qvac/core'
import { diffusionPlugin } from '@qvac/core/sdcpp-generation/plugin'

registerPlugin(diffusionPlugin)

try {
  const modelId = await loadModel({
    modelSrc: SD_V2_1_1B_Q8_0,
    modelType: 'sdcpp-generation',
    modelConfig: { prediction: 'v' }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const prompt = Bare.argv.slice(2)[0] ?? 'a photo of a cat sitting on a windowsill'
  const { outputs } = diffusion({ modelId, prompt })
  const buffers = await outputs

  const first = buffers[0]
  if (first) {
    fs.writeFileSync('output.png', first)
    console.log('▸ Saved output.png')
  }

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
