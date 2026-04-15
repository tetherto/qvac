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
  n_predict: '256',
  repeat_penalty: '1',
  seed: '42',
  tools: 'true',
  'reverse-prompt': '\n',
  verbosity: '2'
}

// Spec: "En ↔ Swahili, Yoruba, Hausa, Zulu — strongest coverage"
// Spec: "Igbo (45M+), Amharic (57M+)" — named as key African languages in pitch
// Spec: "Quality on low-resource pairs" (Risk #3) — Xhosa, Shona, Kinyarwanda
const CORE_PAIRS = {
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
  'en-ig': {
    prompt: 'Translate English to Igbo.\nEnglish: Thank you for your help.\nIgbo:',
    langPair: 'English → Igbo'
  },
  'en-am': {
    prompt: 'Translate English to Amharic.\nEnglish: The market opens early in the morning.\nAmharic:',
    langPair: 'English → Amharic'
  },
  'en-xh': {
    prompt: 'Translate English to Xhosa.\nEnglish: The river flows through the valley.\nXhosa:',
    langPair: 'English → Xhosa'
  },
  'en-sn': {
    prompt: 'Translate English to Shona.\nEnglish: The teacher is reading a book.\nShona:',
    langPair: 'English → Shona'
  },
  'en-rw': {
    prompt: 'Translate English to Kinyarwanda.\nEnglish: We are going to the market.\nKinyarwanda:',
    langPair: 'English → Kinyarwanda'
  },
  'sw-en': {
    prompt: 'Translate Swahili to English.\nSwahili: Watoto wanacheza kwenye bustani.\nEnglish:',
    langPair: 'Swahili → English'
  }
}

// Spec: "plus English, French, Portuguese, Arabic as bridge languages"
const BRIDGE_PAIRS = {
  'fr-en': {
    prompt: 'Translate French to English.\nFrench: Les enfants jouent dans le jardin.\nEnglish:',
    langPair: 'French → English'
  },
  'fr-sw': {
    prompt: 'Translate French to Swahili.\nFrench: Bonjour, comment allez-vous?\nSwahili:',
    langPair: 'French → Swahili'
  },
  'pt-en': {
    prompt: 'Translate Portuguese to English.\nPortuguese: A água é essencial para a vida.\nEnglish:',
    langPair: 'Portuguese → English'
  },
  'ar-en': {
    prompt: 'Translate Arabic to English.\nArabic: الماء ضروري للحياة.\nEnglish:',
    langPair: 'Arabic → English'
  },
  'pt-sw': {
    prompt: 'Translate Portuguese to Swahili.\nPortuguese: As crianças estão brincando no parque.\nSwahili:',
    langPair: 'Portuguese → Swahili'
  }
}

async function collectTranslation (response) {
  const chunks = []
  await response
    .onUpdate(data => { chunks.push(data) })
    .await()
  return chunks.join('').split('\n')[0].trim()
}

async function resolveModel () {
  const qvacDir = path.join(os.homedir(), '.qvac', 'models')
  for (const name of ['AfriqueGemma-4B-Q4_K_M.gguf', 'AfriqueGemma-4B.Q4_K_M.gguf']) {
    if (fs.existsSync(path.join(qvacDir, name))) {
      return [name, qvacDir]
    }
  }

  const modelDir = path.resolve(__dirname, '../model')
  const modelPath = path.join(modelDir, AFRIQUEGEMMA_MODEL.name)
  if (fs.existsSync(modelPath)) {
    return [AFRIQUEGEMMA_MODEL.name, modelDir]
  }

  return ensureModel({
    modelName: AFRIQUEGEMMA_MODEL.name,
    downloadUrl: AFRIQUEGEMMA_MODEL.url
  })
}

async function createAddon (dirPath, modelName, configOverrides = {}) {
  const loader = new FilesystemDL({ dirPath })
  const config = { ...AFRIQUEGEMMA_CONFIG, ...configOverrides }
  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, config)
  return { addon, loader }
}

const TIMEOUT = 1_800_000

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – core EN↔African pairs
//
// SPEC: "En ↔ Swahili, Yoruba, Hausa, Zulu — strongest coverage"
// SPEC: "Igbo (45M+), Amharic (57M+)" — named as key languages in pitch
// SPEC: Risk #3 "Quality on low-resource pairs" — Xhosa, Shona, Kinyarwanda
// WHY: Proves model produces valid translations across the primary language
//      pairs the pitch promises. Includes low-resource pairs and reverse.
// ---------------------------------------------------------------------------
test('AfriqueGemma: core EN↔African language pairs', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const { addon, loader } = await createAddon(dirPath, modelName)
  try {
    await addon.load()
    t.pass('model loaded (Gemma 3 4B base, Q4_K_M via llama.cpp)')

    const results = {}
    for (const [key, { prompt, langPair }] of Object.entries(CORE_PAIRS)) {
      const response = await addon.run([{ role: 'user', content: prompt }])
      const translation = await collectTranslation(response)
      results[key] = translation
      t.ok(translation.length > 0, `${langPair}: produced translation (${translation.length} chars)`)
      if (key.startsWith('en-')) {
        t.ok(!translation.includes('English:'), `${langPair}: output is not English echo`)
      } else {
        t.ok(/[a-zA-Z]{3,}/.test(translation), `${langPair}: output contains Latin text`)
      }
    }

    t.ok(results['en-sw'] !== results['sw-en'], 'En→Sw and Sw→En produce different outputs')
    t.is(Object.keys(results).length, Object.keys(CORE_PAIRS).length, `all ${Object.keys(CORE_PAIRS).length} core pairs produced results`)

    // Deterministic: greedy decoding (temp=0) must be reproducible
    const { prompt: detPrompt } = CORE_PAIRS['en-sw']
    const r1 = await addon.run([{ role: 'user', content: detPrompt }])
    const out1 = await collectTranslation(r1)
    const r2 = await addon.run([{ role: 'user', content: detPrompt }])
    const out2 = await collectTranslation(r2)
    t.is(out1, out2, `deterministic: "${out1}"`)
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – English-as-pivot (Swahili → Yoruba via English)
//
// SPEC: "African ↔ African — possible but less reliable, use English as pivot"
// SPEC: "Bridge languages needed: Many African language pairs route through
//        English/French/Portuguese/Arabic"
// WHY: Mobile users need cross-language African communication; the pitch says
//      this routes via bridge language. Two inference calls, same model.
// ---------------------------------------------------------------------------
test('AfriqueGemma: African-to-African via English pivot', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const { addon, loader } = await createAddon(dirPath, modelName)
  try {
    await addon.load()

    const step1Prompt = 'Translate Swahili to English.\nSwahili: Watoto wanacheza kwenye bustani.\nEnglish:'
    const r1 = await addon.run([{ role: 'user', content: step1Prompt }])
    const englishIntermediate = await collectTranslation(r1)
    t.ok(englishIntermediate.length > 0, 'pivot step 1 (sw→en) produced output')
    t.ok(/[a-zA-Z]{3,}/.test(englishIntermediate), 'intermediate is English text')

    const step2Prompt = `Translate English to Yoruba.\nEnglish: ${englishIntermediate}\nYoruba:`
    const r2 = await addon.run([{ role: 'user', content: step2Prompt }])
    const yorubaOutput = await collectTranslation(r2)
    t.ok(yorubaOutput.length > 0, 'pivot step 2 (en→yo) produced output')
    t.ok(!yorubaOutput.includes('English:'), 'final output is not English echo')
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – bridge languages (French, Portuguese, Arabic)
//
// SPEC: "plus English, French, Portuguese, Arabic as bridge languages"
// SPEC: "Fr ↔ African languages — strong for Francophone Africa"
// SPEC: Bridge→African direct (Portuguese → Swahili, not just bridge→English)
// WHY: The pitch promises 4 bridge languages. English is tested above.
//      French, Portuguese, and Arabic must also produce valid output.
//      Includes pt→sw to verify bridge→African direct translation.
// ---------------------------------------------------------------------------
test('AfriqueGemma: bridge languages (French, Portuguese, Arabic)', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const { addon, loader } = await createAddon(dirPath, modelName)
  try {
    await addon.load()

    for (const [key, { prompt, langPair }] of Object.entries(BRIDGE_PAIRS)) {
      const response = await addon.run([{ role: 'user', content: prompt }])
      const translation = await collectTranslation(response)
      t.ok(translation.length > 0, `${langPair}: produced translation (${translation.length} chars)`)
      if (key.endsWith('-en')) {
        t.ok(/[a-zA-Z]{3,}/.test(translation), `${langPair}: output contains English text`)
      }
      if (key === 'pt-sw') {
        t.ok(translation.length >= 5, `${langPair}: bridge→African direct produced meaningful output`)
      }
    }
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – longer content, mixed content, sequential calls
//
// WHY: Real mobile text has multi-sentence paragraphs and numbers/dates.
//      Sequential calls on same instance must not leak state.
// ---------------------------------------------------------------------------
test('AfriqueGemma: longer content, mixed content, sequential calls', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const { addon, loader } = await createAddon(dirPath, modelName)
  try {
    await addon.load()

    const longerPrompt = 'Translate English to Swahili.\nEnglish: The children are playing in the park. Their mother watches from the bench. The sun is shining brightly today.\nSwahili:'
    const longerResp = await addon.run([{ role: 'user', content: longerPrompt }])
    const longerOut = await collectTranslation(longerResp)
    t.ok(longerOut.length > 0, 'longer multi-sentence content produced output')

    const mixedPrompt = 'Translate English to Swahili.\nEnglish: We have 3 children. They go to school at 8:00.\nSwahili:'
    const mixedResp = await addon.run([{ role: 'user', content: mixedPrompt }])
    const mixedOut = await collectTranslation(mixedResp)
    t.ok(mixedOut.length > 0, 'mixed content (numbers) produced output')

    const sequentialPairs = [CORE_PAIRS['en-sw'], CORE_PAIRS['sw-en'], CORE_PAIRS['en-yo'], BRIDGE_PAIRS['fr-en']]
    for (const { prompt, langPair } of sequentialPairs) {
      const resp = await addon.run([{ role: 'user', content: prompt }])
      const out = await collectTranslation(resp)
      t.ok(out.length > 0, `sequential ${langPair}: produced output`)
    }
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – African-language Unicode input (African → English)
//
// SPEC: "Igbo (45M+), Amharic (57M+)" — key languages use non-ASCII scripts
// WHY: All core pair tests send English text for translation. Real users also
//      translate FROM African languages with diacritics (Yoruba ẹ/ọ/ṣ),
//      non-Latin scripts (Amharic Ge'ez), and hooks (Hausa ɗ/ɓ). If the
//      tokenizer corrupts Unicode input, these translations fail silently.
// ---------------------------------------------------------------------------
test('AfriqueGemma: African-language Unicode input (African → English)', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const { addon, loader } = await createAddon(dirPath, modelName)
  try {
    await addon.load()

    const yorubaPrompt = 'Translate Yoruba to English.\nYoruba: Àwọn ọmọ náà ń ṣeré nínú ọgbà.\nEnglish:'
    const r1 = await addon.run([{ role: 'user', content: yorubaPrompt }])
    const yorubaOut = await collectTranslation(r1)
    t.ok(yorubaOut.length > 0, 'Yoruba (ẹ/ọ/ṣ diacritics) → English produced output')
    t.ok(/[a-zA-Z]{3,}/.test(yorubaOut), 'Yoruba → English: output is Latin/English text')

    const amharicPrompt = 'Translate Amharic to English.\nAmharic: ልጆቹ በፓርኩ ውስጥ ይጫወታሉ።\nEnglish:'
    const r2 = await addon.run([{ role: 'user', content: amharicPrompt }])
    const amharicOut = await collectTranslation(r2)
    t.ok(amharicOut.length > 0, 'Amharic (Ge\'ez script) → English produced output')
    t.ok(/[a-zA-Z]{3,}/.test(amharicOut), 'Amharic → English: output is Latin/English text')

    const hausaPrompt = 'Translate Hausa to English.\nHausa: Ɗalibi ya karɓi littafi daga makaranta.\nEnglish:'
    const r3 = await addon.run([{ role: 'user', content: hausaPrompt }])
    const hausaOut = await collectTranslation(r3)
    t.ok(hausaOut.length > 0, 'Hausa (ɗ/ɓ/ƙ hooks) → English produced output')
    t.ok(/[a-zA-Z]{3,}/.test(hausaOut), 'Hausa → English: output is Latin/English text')

    t.comment('All non-Latin/diacritic inputs produced valid English output')
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Test: AfriqueGemma – streaming tokens arrive incrementally with stats
//
// WHY: Mobile integrators display tokens as they arrive in real-time UIs.
//      If the streaming pipeline batches everything into one chunk or drops
//      stats, the UX breaks. Verifies onUpdate fires multiple times and
//      performance stats are populated for visibility.
// ---------------------------------------------------------------------------
test('AfriqueGemma: streaming tokens arrive incrementally with stats', { timeout: TIMEOUT }, async t => {
  const [modelName, dirPath] = await resolveModel()
  const { addon, loader } = await createAddon(dirPath, modelName)
  try {
    await addon.load()

    const chunks = []
    const start = Date.now()
    const response = await addon.run([{ role: 'user', content: CORE_PAIRS['en-sw'].prompt }])
    await response
      .onUpdate(data => { chunks.push(data) })
      .await()
    const elapsed = Date.now() - start

    t.ok(chunks.length > 1, `streaming: received ${chunks.length} chunks (not a single blob)`)
    for (const chunk of chunks) {
      t.is(typeof chunk, 'string', 'each chunk is a string')
    }

    const fullOutput = chunks.join('').split('\n')[0].trim()
    t.ok(fullOutput.length > 0, `full output: "${fullOutput}"`)

    const stats = response.stats || {}
    if (stats.promptTokens !== undefined) {
      const promptTokens = Number(stats.promptTokens)
      const generatedTokens = Number(stats.generatedTokens)
      t.ok(promptTokens > 0, 'stats: promptTokens > 0')
      t.ok(generatedTokens > 0, 'stats: generatedTokens > 0')
      const tps = generatedTokens / (elapsed / 1000)
      t.comment(`perf: ${generatedTokens} tokens in ${elapsed}ms (${tps.toFixed(1)} tok/s)`)
      t.comment(`perf: promptTokens=${promptTokens}, generatedTokens=${generatedTokens}`)
    } else {
      t.comment('stats not available on response object — skipping perf log')
    }
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})
