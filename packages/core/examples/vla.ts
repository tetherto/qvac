// Vision-language-action (SmolVLA): one inference pass with synthetic inputs
// (gray images, BOS-only tokens, zero state and noise) that prints the produced
// action chunk. A real consumer feeds camera frames, a tokenized instruction,
// and the robot's current pose.
//
// Run: bare examples/vla.ts
// Requires: npm install @qvac/core @qvac/vla-ggml

import {
  registerPlugin,
  loadModel,
  unloadModel,
  vla,
  vlaHparams,
  vlaPreprocessImage,
  vlaPadState,
  SMOLVLA_LIBERO_VISION_Q8
} from '@qvac/core'
import { vlaPlugin } from '@qvac/core/ggml-vla/plugin'

registerPlugin(vlaPlugin)

try {
  const modelId = await loadModel({
    modelSrc: SMOLVLA_LIBERO_VISION_Q8,
    modelType: 'ggml-vla',
    modelConfig: { backend: 'cpu' }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const { hparams } = await vlaHparams({ modelId })
  const size = hparams.visionImageSize
  const pixels = new Uint8Array(size * size * 3).fill(128)
  const front = vlaPreprocessImage(pixels, size, size, { size })
  const wrist = vlaPreprocessImage(pixels, size, size, { size })

  const tokens = new Int32Array(hparams.tokenizerMaxLength)
  const mask = new Uint8Array(hparams.tokenizerMaxLength)
  tokens[0] = 1
  mask[0] = 1

  const state = vlaPadState([0, 0, 0, 0, 0, 0], hparams.maxStateDim)
  const noise = new Float32Array(hparams.chunkSize * hparams.maxActionDim)

  const { actions, actionDim, chunkSize } = await vla({
    modelId,
    images: [front, wrist],
    imgWidth: size,
    imgHeight: size,
    state,
    tokens,
    mask,
    noise
  })
  console.log(`▸ ${chunkSize} action steps of dim ${actionDim}`)
  console.log(Array.from(actions.subarray(0, actionDim)))

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
