// Translation with an NMT (Bergamot) model. Bergamot derives its vocabulary
// files from the model source automatically.
//
// Run: bare examples/translate.ts
// Requires: npm install @qvac/core @qvac/translation-nmtcpp

import { registerPlugin, loadModel, translate, unloadModel, BERGAMOT_EN_FR } from '@qvac/core'
import { nmtPlugin } from '@qvac/core/nmtcpp-translation/plugin'

registerPlugin(nmtPlugin)

try {
  const modelId = await loadModel({
    modelSrc: BERGAMOT_EN_FR,
    modelConfig: { engine: 'Bergamot', from: 'en', to: 'fr', beamsize: 1, normalize: 1 }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const text = 'This is a test of the Bergamot translation model.'
  const result = translate({ modelId, text, modelType: 'nmtcpp-translation', stream: false })
  console.log(`EN -> FR: ${text} -> "${await result.text}"`)

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
