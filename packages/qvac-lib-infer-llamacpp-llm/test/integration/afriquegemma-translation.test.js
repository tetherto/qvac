'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const os = require('bare-os')
const fs = require('bare-fs')
const path = require('bare-path')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'
const useCpu = isDarwinX64 || isLinuxArm64

const AFRIQUEGEMMA_MODEL = {
  name: 'AfriqueGemma-4B.Q4_K_M.gguf',
  url: 'https://huggingface.co/mradermacher/AfriqueGemma-4B-GGUF/resolve/main/AfriqueGemma-4B.Q4_K_M.gguf'
}

const AFRIQUEGEMMA_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '2048',
  temp: '0',
  top_p: '1',
  top_k: '1',
  n_predict: '64',
  repeat_penalty: '1',
  seed: '42',
  tools: 'true',
  verbosity: '2'
}

const TRANSLATION_PROMPTS = {
  'en-sw': {
    prompt: 'Translate English to Swahili.\nEnglish: The children are playing in the park.\nSwahili:',
    langPair: 'English → Swahili'
  },
  'en-yo': {
    prompt: 'Translate English to Yoruba.\nEnglish: Good morning, how are you today?\nYoruba:',
    langPair: 'English → Yoruba'
  },
  'en-ha': {
    prompt: 'Translate English to Hausa.\nEnglish: Water is essential for life.\nHausa:',
    langPair: 'English → Hausa'
  },
  'en-zu': {
    prompt: 'Translate English to Zulu.\nEnglish: The sun rises in the east.\nZulu:',
    langPair: 'English → Zulu'
  },
  'sw-en': {
    prompt: 'Translate Swahili to English.\nSwahili: Watoto wanacheza kwenye bustani.\nEnglish:',
    langPair: 'Swahili → English'
  },
  'fr-en': {
    prompt: 'Translate French to English.\nFrench: Les enfants jouent dans le jardin.\nEnglish:',
    langPair: 'French → English'
  }
}

async function collectTranslation (response, model) {
  let text = ''
  let stopped = false
  await response
    .onUpdate(async data => {
      if (stopped) return
      text += data
      if (text.includes('\n')) {
        text = text.split('\n')[0]
        stopped = true
        await model.cancel()
      }
    })
    .await()
  return text.trim()
}

async function collectResponse (response) {
  const chunks = []
  await response
    .onUpdate(data => { chunks.push(data) })
    .await()
  return chunks.join('').trim()
}

async function resolveModel () {
  // 1. Check ~/.qvac/models/ first (common local dev path, avoids re-downloading)
  const qvacDir = path.join(os.homedir(), '.qvac', 'models')
  for (const name of ['AfriqueGemma-4B-Q4_K_M.gguf', 'AfriqueGemma-4B.Q4_K_M.gguf']) {
    if (fs.existsSync(path.join(qvacDir, name))) {
      return [name, qvacDir]
    }
  }

  // 2. Check test/model/ dir
  const modelDir = path.resolve(__dirname, '../model')
  const modelPath = path.join(modelDir, AFRIQUEGEMMA_MODEL.name)
  if (fs.existsSync(modelPath)) {
    return [AFRIQUEGEMMA_MODEL.name, modelDir]
  }

  // 3. Not found anywhere — download (~2.7 GB) to test/model/
  return ensureModel({
    modelName: AFRIQUEGEMMA_MODEL.name,
    downloadUrl: AFRIQUEGEMMA_MODEL.url
  })
}

const skipReason = isMobile

// ---------------------------------------------------------------------------
// Single test: load model ONCE, run all translation assertions, unload ONCE
// ---------------------------------------------------------------------------
test('AfriqueGemma: end-to-end African language translation', { timeout: 1_800_000, skip: skipReason }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const loader = new FilesystemDL({ dirPath })

  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, AFRIQUEGEMMA_CONFIG)

  try {
    // --- Model loading ---
    await addon.load()
    t.pass('model loaded with tools: true (jinja chat template enabled)')

    const basicResponse = await addon.run([{ role: 'user', content: 'Hello' }])
    const basicOutput = await collectResponse(basicResponse)
    t.ok(basicOutput.length > 0, `basic inference works (${basicOutput.length} chars)`)

    // --- All 6 translation pairs (En→X and X→En) ---
    console.log('\n--- Translation pairs ---')
    const results = {}
    for (const [key, { prompt, langPair }] of Object.entries(TRANSLATION_PROMPTS)) {
      const response = await addon.run([{ role: 'user', content: prompt }])
      const translation = await collectTranslation(response, addon)
      results[key] = translation

      t.ok(translation.length > 0, `${langPair}: produced translation (${translation.length} chars)`)

      if (key.startsWith('en-')) {
        t.ok(!translation.includes('English:'), `${langPair}: output is not English echo`)
      } else {
        const hasLatinChars = /[a-zA-Z]{3,}/.test(translation)
        t.ok(hasLatinChars, `${langPair}: output contains English text`)
      }

      console.log(`  ${langPair}: "${translation}"`)
    }

    // Verify different directions produce different outputs
    t.ok(results['en-sw'] !== results['sw-en'], 'En→Sw and Sw→En produce different outputs')
    t.is(Object.keys(results).length, 6, 'all 6 language pairs produced results')

    // --- Deterministic: same prompt twice → same output ---
    console.log('\n--- Deterministic check ---')
    const { prompt: detPrompt } = TRANSLATION_PROMPTS['en-sw']
    const r1 = await addon.run([{ role: 'user', content: detPrompt }])
    const out1 = await collectTranslation(r1, addon)
    const r2 = await addon.run([{ role: 'user', content: detPrompt }])
    const out2 = await collectTranslation(r2, addon)
    t.is(out1, out2, `deterministic: "${out1}"`)
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
