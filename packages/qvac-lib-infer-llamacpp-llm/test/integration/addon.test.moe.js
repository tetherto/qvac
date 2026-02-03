// test/integration/addon.moe.test.js
const { test, skip } = require('brittle')
const settings = require('../../settings.js')
const process = require('bare-process')
const { testTextWithSettings } = require('./utils')

let testTextSuccess = true
async function testMoeText (t, modelNameMoe, downloadUrlMoe) {
  const testSettings = {
    ...settings.getMixtralMoeSettings(modelNameMoe),
    predict: '20'
  }
  await testTextWithSettings(t, modelNameMoe, downloadUrlMoe, testSettings)
  testTextSuccess = testTextSuccess && t.fails === 0
}

async function testMoe (repo, model, solo = false) {
  if (process.env.TEXT_MODEL_NAME) {
    solo = model === process.env.TEXT_MODEL_NAME
  }
  const testF = solo ? test : skip
  await testF(`llama addon MoE can generate text: ${model}`, async (t) => {
    const downloadUrlMoe = `https://huggingface.co/${repo}/resolve/main/${model}`
    await testMoeText(t, model, downloadUrlMoe)
  })
}

async function main () {
  await testMoe('mradermacher/Mixtral-9x7B-Instruct-v0.1-GGUF', 'Mixtral-8x7B-Instruct-v0.1.Q4_K_M.gguf')
  await testMoe('jmb95/laser-dolphin-mixtral-2x7b-dpo-GGUF', 'dolphin-mixtral-2x7b-dop-Q4_K_M.gguf')

  // By default execute only smallest model with --solo
  await testMoe('jmb95/laser-dolphin-mixtral-2x7b-dpo-GGUF', 'dolphin-mixtral-2x7b-dop-Q2_K.gguf', true)

  if (testTextSuccess) {
    console.log('All tests ok')
    process.exit(0)
  } else {
    console.log('Tests failed')
    process.exit(1)
  }
}
main()
