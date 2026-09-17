global.process = require('bare-process')
const { ensureCosyvoiceModel } = require('../test/utils/downloadModel')
const { loadCosyvoiceTTS, runCosyvoiceTTS } = require('../test/utils/runCosyvoiceTTS')
;(async () => {
  if (Bare.argv.includes('download')) { await ensureCosyvoiceModel(); return }
  console.log('Before CosyVoice load')
  const model = await loadCosyvoiceTTS({ useGPU: true })
  console.log('After CosyVoice load')
  try {
    const result = await runCosyvoiceTTS(model, { text: 'GPU smoke check.' }, { minSamples: 1 })
    console.log(result.output, result.passed, result.data.stats)
    if (!result.passed) throw new Error(result.output)
  } finally { await model.destroy() }
  console.log('After CosyVoice destroy')
})().catch((error) => { console.error(error); process.exitCode = 1 })
