// `modelFitPolicy` decides what the engine fitter's verdict does to a load:
// `log` (the default) reports it and loads anyway, `refuse` rejects a load the
// fitter projects will not fit, `off` skips the check.

import { loadModel, loggingStream, SDK_LOG_ID, GPT_OSS_20B_INST_Q4_K_M } from '@qvac/sdk'

// Verdicts go to the SDK server log stream, not stdout.
void (async () => {
  for await (const log of loggingStream({ id: SDK_LOG_ID })) {
    if (log.message.includes('[advisory-fit:')) console.log(`▸ ${log.message}`)
  }
})().catch(() => {})

try {
  // gpt-oss-20B fits here at the default KV cache type and does not at f32.
  await loadModel({
    modelSrc: GPT_OSS_20B_INST_Q4_K_M,
    modelConfig: {
      ctx_size: 131072,
      'cache-type-k': 'f32',
      'cache-type-v': 'f32'
    },
    modelFitPolicy: 'refuse'
  })

  console.log('▸ Loaded — the fitter projected this one to fit here')
  process.exit(0)
} catch (error) {
  console.error('✖', error instanceof Error ? error.message : error)
  process.exit(1)
}
