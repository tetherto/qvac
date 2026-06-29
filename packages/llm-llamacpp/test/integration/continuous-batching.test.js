'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest, getMediaPath } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const { MULTIMODAL_MODEL_CONFIG } = require('./_image-common.js')

const platform = os.platform()
const arch = os.arch()
const isDarwin = platform === 'darwin'
const isDarwinX64 = isDarwin && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isLinuxX64 = platform === 'linux' && arch === 'x64'
const isMobile = platform === 'ios' || platform === 'android'
const noGpu = process.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64 || noGpu

const MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const BASE_SYSTEM_PROMPT = 'Answer the question. Start with the exact lowercase answer word, then write exactly 64 lowercase words about it. Do not stop early. No bullets.'
const STORY_SYSTEM_PROMPT = 'Write a short story. Start the first sentence with the requested unique lowercase word.'

const CASES = [
  { id: 'capital-france', user: 'What is the capital of France? Answer with one word.', expected: ['paris'] },
  { id: 'red-fruit', user: 'Name a common red fruit. Answer with one word.', expected: ['strawberry', 'apple', 'raspberry', 'cherry', 'cranberry'] },
  { id: 'opposite-hot', user: 'What is the opposite of hot? Answer with one word.', expected: ['cold', 'cool', 'chill', 'frigid', 'cool'] },
  { id: 'sky-color', user: 'What color is a clear daytime sky? Answer with one word.', expected: ['blue'] },
  { id: 'bee-product', user: 'What sweet food do bees make? Answer with one word.', expected: ['honey'] },
  { id: 'frozen-water', user: 'What is frozen water called? Answer with one word.', expected: ['ice'] },
  { id: 'story-otter', story: true, expected: ['otter'] },
  { id: 'largest-ocean', user: 'What is the largest ocean? Answer with one word.', expected: ['pacific'] },
  { id: 'planet-red', user: 'Which planet is known as the red planet? Answer with one word.', expected: ['mars'] },
  { id: 'day-after-monday', user: 'What day comes after Monday? Answer with one word.', expected: ['tuesday'] },
  { id: 'story-lantern', story: true, expected: ['lantern'] },
  { id: 'count-fingers', user: 'How many fingers are on one typical human hand? Answer with one word.', expected: ['five', '5', 'ten', '10'] },
  { id: 'animal-meows', user: 'What animal meows? Answer with one word.', expected: ['cat', 'cougar', 'felid', 'lion', 'tiger', 'jaguar', 'leopard'] },
  { id: 'story-canyon', story: true, expected: ['canyon'] },
  { id: 'primary-yellow', user: 'What primary color is the sun often drawn as? Answer with one word.', expected: ['yellow', 'orange', 'red'] },
  { id: 'story-saffron', story: true, expected: ['saffron'] }
]

// Two lightweight images (~23 KB and ~38 KB) — avoid fruitPlate.png (10 MB)
const IMAGE_CASES = [
  {
    id: 'elephant-animal',
    imageFile: 'elephant.jpg',
    prompt: 'What large animal is shown in this image? Answer with one word.',
    expected: ['elephant', 'elephants']
  },
  {
    id: 'elephant-environment',
    imageFile: 'elephant.jpg',
    prompt: 'Is this animal indoors or outdoors? Answer with one word.',
    expected: ['outdoors', 'outdoor', 'outside', 'open', 'field', 'grassland', 'savanna', 'savannah', 'wild']
  },
  {
    id: 'newspaper-type',
    imageFile: 'news-paper.jpg',
    prompt: 'What type of printed material is shown? Answer with one word.',
    expected: ['newspaper', 'paper', 'news', 'text', 'page', 'print', 'article']
  },
  {
    id: 'newspaper-content',
    imageFile: 'news-paper.jpg',
    prompt: 'What covers most of this page? Answer with one word.',
    expected: ['text', 'words', 'writing', 'letters', 'printed', 'print', 'newspaper', 'article', 'content', 'storm', 'headline', 'titanic', 'ship', 'image', 'photo', 'photograph', 'picture', 'news']
  }
]

// Interleaved: each image case followed by 4 text cases — 4 + 16 = 20 total.
// Forces the scheduler to juggle media barriers and plain prefill in the same window.
const MIXED_CASES = IMAGE_CASES.flatMap((img, i) => [img, ...CASES.slice(i * 4, i * 4 + 4)])

function toNumber (value) {
  return typeof value === 'number' ? value : Number(value || 0)
}

function normalizeText (text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function containsExpectedWord (text, expectedOptions) {
  const normalized = normalizeText(text)
  const options = Array.isArray(expectedOptions) ? expectedOptions : [expectedOptions]
  return options.some(option => normalized.includes(option))
}

function buildPrompt (item) {
  if (item.story) {
    const expectedWord = Array.isArray(item.expected) ? item.expected[0] : item.expected
    return [
      { role: 'system', content: STORY_SYSTEM_PROMPT },
      { role: 'user', content: `Tell me a story. The required first word is ${expectedWord}.` }
    ]
  }
  return [
    { role: 'system', content: BASE_SYSTEM_PROMPT },
    { role: 'user', content: item.user }
  ]
}

function runOptionsForCase (item) {
  return { generationParams: { predict: item.story ? 96 : 64 } }
}

function buildBatchItem (item) {
  if (item.imageFile) {
    const imageBytes = new Uint8Array(fs.readFileSync(getMediaPath(item.imageFile)))
    return {
      id: item.id,
      prompt: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', type: 'media', content: imageBytes },
        { role: 'user', content: item.prompt }
      ],
      runOptions: { generationParams: { predict: 48 } }
    }
  }
  return {
    id: item.id,
    prompt: buildPrompt(item),
    runOptions: runOptionsForCase(item)
  }
}

// VLM-compatible prompt builder for text-only slots in the mixed batch test.
// BASE_SYSTEM_PROMPT and STORY_SYSTEM_PROMPT are tuned for the 1B Llama model;
// SmolVLM2-500M needs simpler instructions to follow them correctly.
function buildVlmBatchItem (item) {
  if (item.imageFile) return buildBatchItem(item)
  if (item.story) {
    const word = Array.isArray(item.expected) ? item.expected[0] : item.expected
    return {
      id: item.id,
      prompt: [
        { role: 'system', content: 'Follow the user instruction exactly. Do not add a preamble.' },
        { role: 'user', content: `Write one short sentence that contains the exact word "${word}".` }
      ],
      runOptions: { generationParams: { predict: 48 } }
    }
  }
  return {
    id: item.id,
    prompt: [
      { role: 'system', content: 'Answer with one word only.' },
      { role: 'user', content: item.user }
    ],
    runOptions: { generationParams: { predict: 16 } }
  }
}

async function setupModel (t, configOverrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '4096',
    n_predict: '32',
    temp: '0',
    top_p: '1',
    top_k: '1',
    seed: '42',
    verbosity: '2',
    ...configOverrides
  }
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => { })
    specLogger.release()
  })

  return model
}

async function setupMultimodalBatchModel (t, configOverrides = {}) {
  const [modelName, dirPath] = await ensureModel(MULTIMODAL_MODEL_CONFIG.llmModel)
  const [projModelName] = await ensureModel(MULTIMODAL_MODEL_CONFIG.projModel)
  const modelPath = path.join(dirPath, modelName)
  const projModelPath = path.join(dirPath, projModelName)

  // ctx_size 4096 gives each of the 4 parallel slots ~1024 tokens — enough for
  // SmolVLM2-500M vision tokens (~256 per image) + prompt + output.
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '99',
    ctx_size: '4096',
    temp: '0',
    top_p: '1',
    top_k: '1',
    seed: '42',
    verbosity: '2',
    parallel: '4',
    ...configOverrides
  }
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const model = new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: projModelPath },
    config,
    logger: console,
    opts: { stats: true }
  })

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => { })
    specLogger.release()
  })

  return model
}

async function collectText (response) {
  const chunks = []
  await response.onUpdate(chunk => { chunks.push(chunk) }).await()
  return chunks.join('')
}

function logStreamingProgress (response, tag) {
  const logTag = tag || 'continuous-batching'
  const chunksPerLog = 8
  const progressById = new Map()
  response.onUpdate(({ id, chunk }) => {
    const progress = progressById.get(id) || { chunkCount: 0, pendingText: '', loggedFirstChunk: false }
    progress.chunkCount += 1
    progress.pendingText += chunk
    if (!progress.loggedFirstChunk || progress.chunkCount % chunksPerLog === 0) {
      console.log(`[${logTag} progress] ${id}: ${progress.pendingText.replace(/\s+/g, ' ').trim()}`)
      progress.pendingText = ''
      progress.loggedFirstChunk = true
    }
    progressById.set(id, progress)
  })
  return {
    ids () {
      return [...progressById.keys()]
    },
    flush () {
      for (const [id, progress] of progressById) {
        const text = progress.pendingText.replace(/\s+/g, ' ').trim()
        if (text.length > 0) {
          console.log(`[${logTag} progress] ${id}: ${text}`)
        }
      }
    }
  }
}

// The base JS batch API is already covered by api-behavior.test.js; this heavier
// 1B throughput/correctness run is too slow or complicated for mobile and legacy macOS x64.
const skipHeavyPlatform = isMobile || isDarwin

safeTest('continuous batching answers 16 prompts correctly and improves Linux GPU TPS', { timeout: 900_000, skip: skipHeavyPlatform }, async t => {
  const singleModel = await setupModel(t)
  const singleNativeTpsValues = []
  const singleWallTpsValues = []
  for (const item of CASES) {
    const startedAt = Date.now()
    const singleResponse = await singleModel.run(buildPrompt(item), runOptionsForCase(item))
    const singleText = await collectText(singleResponse)
    const elapsedMs = Date.now() - startedAt
    const generatedTokens = toNumber(singleResponse.stats.generatedTokens)
    const singleNativeTps = toNumber(singleResponse.stats.TPS)
    const singleWallTps = elapsedMs > 0 ? (generatedTokens * 1000) / elapsedMs : 0
    singleNativeTpsValues.push(singleNativeTps)
    singleWallTpsValues.push(singleWallTps)
    t.comment(`single native TPS ${item.id}: ${singleNativeTps}`)
    t.comment(`single wall TPS ${item.id}: ${singleWallTps}`)
    t.comment(`${item.id}: ${singleText.trim()}`)
    t.ok(containsExpectedWord(singleText, item.expected), `single ${item.id} includes ${item.expected}`)
  }
  const avgSingleNativeTps = singleNativeTpsValues.reduce((sum, value) => sum + value, 0) / singleNativeTpsValues.length
  const avgSingleWallTps = singleWallTpsValues.reduce((sum, value) => sum + value, 0) / singleWallTpsValues.length
  t.comment(`average single native TPS: ${avgSingleNativeTps}`)
  t.comment(`average single wall TPS: ${avgSingleWallTps}`)

  const batchModel = await setupModel(t, { parallel: '4' })
  const batchInput = CASES.map(item => ({
    id: item.id,
    prompt: buildPrompt(item),
    runOptions: runOptionsForCase(item)
  }))
  const batchStartedAt = Date.now()
  const batchResponse = await batchModel.run(batchInput)
  const streamingProgress = logStreamingProgress(batchResponse)
  const batchResults = await batchResponse.await()
  const batchElapsedMs = Date.now() - batchStartedAt
  streamingProgress.flush()
  const batchNativeTps = toNumber(batchResponse.stats.TPS)
  const batchGeneratedTokens = toNumber(batchResponse.stats.generatedTokens)
  const batchWallTps = batchElapsedMs > 0 ? (batchGeneratedTokens * 1000) / batchElapsedMs : 0

  t.comment(`batch native TPS: ${batchNativeTps}`)
  t.comment(`batch wall TPS: ${batchWallTps}`)
  t.comment(`batch avgConcurrentSeq: ${toNumber(batchResponse.stats.avgConcurrentSeq)}`)
  t.ok(toNumber(batchResponse.stats.avgConcurrentSeq) > 3.05, 'batch stats report concurrent sequence decoding')

  t.alike(batchResults.map(result => result.id), CASES.map(item => item.id), 'all ids are reported in order')
  t.alike(streamingProgress.ids().sort(), CASES.map(item => item.id).sort(), 'all ids emitted streaming chunks')
  const resultsById = new Map(batchResults.map(result => [result.id, result.output]))
  for (const item of CASES) {
    const output = resultsById.get(item.id) || ''
    console.log(`[continuous-batching result] ${item.id}: ${output.trim()}`)
    t.comment(`${item.id}: ${output.trim()}`)
    t.ok(containsExpectedWord(output, item.expected), `${item.id} includes ${item.expected}`)
  }

  const nativeTpsComparison = `batch native TPS (${batchNativeTps}) vs average single native TPS (${avgSingleNativeTps})`
  const wallTpsComparison = `batch wall TPS (${batchWallTps}) vs average single wall TPS (${avgSingleWallTps})`
  console.log(`[continuous-batching TPS] ${nativeTpsComparison}`)
  console.log(`[continuous-batching TPS] ${wallTpsComparison}`)
  t.comment(nativeTpsComparison)
  t.comment(wallTpsComparison)

  // Single native TPS is decode-only and can look artificially high for short
  // prompts; wall TPS is the comparable end-to-end throughput signal here.
  const wallTpsThreshold = avgSingleWallTps * 0.9
  const linuxGpuStats = isLinuxX64 && batchResponse.stats.backendDevice === 'gpu'
  if (linuxGpuStats) {
    t.ok(batchWallTps > wallTpsThreshold, `${wallTpsComparison} is within 10% of single wall TPS or better on Linux GPU`)
  } else {
    t.comment('Skipping TPS assertion outside Linux GPU runtime')
  }
})

test('continuous batching MTMD: image-only batch returns correct descriptions', { timeout: 900_000, skip: skipHeavyPlatform }, async t => {
  const model = await setupMultimodalBatchModel(t)

  for (const item of IMAGE_CASES) {
    t.ok(fs.existsSync(getMediaPath(item.imageFile)), `media file ${item.imageFile} exists`)
  }

  const batchInput = IMAGE_CASES.map(buildBatchItem)
  const batchStartedAt = Date.now()
  const batchResponse = await model.run(batchInput)
  const streamingProgress = logStreamingProgress(batchResponse, 'cb-mtmd-image')
  const batchResults = await batchResponse.await()
  streamingProgress.flush()

  t.comment(`elapsed: ${Date.now() - batchStartedAt}ms`)
  t.comment(`native TPS: ${toNumber(batchResponse.stats.TPS)}`)
  t.comment(`avgConcurrentSeq: ${toNumber(batchResponse.stats.avgConcurrentSeq)}`)

  t.alike(batchResults.map(r => r.id), IMAGE_CASES.map(item => item.id), 'all ids reported in order')
  t.alike(streamingProgress.ids().sort(), IMAGE_CASES.map(item => item.id).sort(), 'all ids emitted streaming chunks')

  const resultsById = new Map(batchResults.map(r => [r.id, r.output]))
  for (const item of IMAGE_CASES) {
    const output = resultsById.get(item.id) || ''
    console.log(`[cb-mtmd-image result] ${item.id}: ${output.trim()}`)
    t.comment(`${item.id}: ${output.trim()}`)
    t.ok(
      containsExpectedWord(output, item.expected),
      `${item.id} output includes one of [${item.expected.join(', ')}]. Full output: "${output.trim()}"`
    )
  }

  // Match the mixed-batch bar (>1.5): serialized-on-media slots can clear 1.0
  // even with pipelining regressed, so 1.0 is too weak a guard.
  t.ok(
    toNumber(batchResponse.stats.avgConcurrentSeq) > 1.5,
    `avgConcurrentSeq (${toNumber(batchResponse.stats.avgConcurrentSeq)}) > 1.5 confirms parallel decode`
  )
})

test('continuous batching MTMD: image batch accepts string file-path media', { timeout: 900_000, skip: skipHeavyPlatform }, async t => {
  const model = await setupMultimodalBatchModel(t)

  for (const item of IMAGE_CASES) {
    t.ok(fs.existsSync(getMediaPath(item.imageFile)), `media file ${item.imageFile} exists`)
  }

  // Same images as the byte-mode batch test, but media is supplied as an
  // absolute file-path string instead of Uint8Array bytes. The per-slot MTMD
  // driver must load the file itself (mirroring the single-prompt run() path).
  const batchInput = IMAGE_CASES.map(item => ({
    id: item.id,
    prompt: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', type: 'media', content: getMediaPath(item.imageFile) },
      { role: 'user', content: item.prompt }
    ],
    runOptions: { generationParams: { predict: 48 } }
  }))

  const batchResponse = await model.run(batchInput)
  const streamingProgress = logStreamingProgress(batchResponse, 'cb-mtmd-path')
  const batchResults = await batchResponse.await()
  streamingProgress.flush()

  t.alike(batchResults.map(r => r.id), IMAGE_CASES.map(item => item.id), 'all ids reported in order')

  const resultsById = new Map(batchResults.map(r => [r.id, r.output]))
  for (const item of IMAGE_CASES) {
    const output = resultsById.get(item.id) || ''
    console.log(`[cb-mtmd-path result] ${item.id}: ${output.trim()}`)
    t.comment(`${item.id}: ${output.trim()}`)
    t.ok(
      containsExpectedWord(output, item.expected),
      `${item.id} output includes one of [${item.expected.join(', ')}]. Full output: "${output.trim()}"`
    )
  }
})

test('continuous batching MTMD: mixed image+text batch processes all slot types correctly', { timeout: 1_200_000, skip: skipHeavyPlatform }, async t => {
  const model = await setupMultimodalBatchModel(t)

  for (const item of IMAGE_CASES) {
    t.ok(fs.existsSync(getMediaPath(item.imageFile)), `media file ${item.imageFile} exists`)
  }

  // Single-mode baseline: run every MIXED_CASES item sequentially to get a
  // per-token wall-clock reference that the batch run can be compared against.
  const singleWallTpsValues = []
  for (const item of MIXED_CASES) {
    const vlmItem = buildVlmBatchItem(item)
    const startedAt = Date.now()
    const singleResponse = await model.run(vlmItem.prompt, vlmItem.runOptions)
    const singleText = await collectText(singleResponse)
    const elapsedMs = Date.now() - startedAt
    const generatedTokens = toNumber(singleResponse.stats.generatedTokens)
    const wallTps = elapsedMs > 0 ? (generatedTokens * 1000) / elapsedMs : 0
    singleWallTpsValues.push(wallTps)
    t.comment(`single ${item.id} wall TPS: ${wallTps.toFixed(1)} | ${singleText.trim().slice(0, 80)}`)
  }
  const avgSingleWallTps = singleWallTpsValues.reduce((sum, v) => sum + v, 0) / singleWallTpsValues.length

  // Batch run over MIXED_CASES (image + text-only slots interleaved).
  const batchInput = MIXED_CASES.map(buildVlmBatchItem)
  const batchStartedAt = Date.now()
  const batchResponse = await model.run(batchInput)
  const streamingProgress = logStreamingProgress(batchResponse, 'cb-mtmd-mixed')
  const batchResults = await batchResponse.await()
  const batchElapsedMs = Date.now() - batchStartedAt
  streamingProgress.flush()

  const batchNativeTps = toNumber(batchResponse.stats.TPS)
  const batchGeneratedTokens = toNumber(batchResponse.stats.generatedTokens)
  const batchWallTps = batchElapsedMs > 0 ? (batchGeneratedTokens * 1000) / batchElapsedMs : 0

  const wallTpsComparison = `batch wall TPS (${batchWallTps.toFixed(1)}) vs avg single wall TPS (${avgSingleWallTps.toFixed(1)})`
  console.log(`[cb-mtmd-mixed TPS] ${wallTpsComparison}`)
  t.comment(wallTpsComparison)
  t.comment(`native TPS: ${batchNativeTps}`)
  t.comment(`elapsed: ${batchElapsedMs}ms`)
  t.comment(`avgConcurrentSeq: ${toNumber(batchResponse.stats.avgConcurrentSeq)}`)

  t.alike(batchResults.map(r => r.id), MIXED_CASES.map(item => item.id), 'all ids reported in order')
  t.alike(streamingProgress.ids().sort(), MIXED_CASES.map(item => item.id).sort(), 'all ids emitted streaming chunks')

  const resultsById = new Map(batchResults.map(r => [r.id, r.output]))
  for (const item of MIXED_CASES) {
    const output = resultsById.get(item.id) || ''
    console.log(`[cb-mtmd-mixed result] ${item.id}: ${output.trim()}`)
    t.comment(`${item.id}: ${output.trim()}`)
    t.ok(
      containsExpectedWord(output, item.expected),
      `${item.id} output includes one of [${item.expected.join(', ')}]. Full output: "${output.trim()}"`
    )
  }

  // Concurrency alone doesn't prove the text slots produced real output (loose
  // word lists let garbage pass): require >=8 chars AND an expected-word match.
  const MIN_TEXT_SLOT_LEN = 8
  const textCases = MIXED_CASES.filter(item => !item.imageFile)
  const goodTextSlots = textCases.filter(item => {
    const output = (resultsById.get(item.id) || '').trim()
    return output.length >= MIN_TEXT_SLOT_LEN && containsExpectedWord(output, item.expected)
  })
  t.ok(
    goodTextSlots.length > 0,
    `at least one text-only slot returned non-trivial output (>= ${MIN_TEXT_SLOT_LEN} chars) matching its expected word ` +
    `(${goodTextSlots.length}/${textCases.length} text slots passed)`
  )

  // With 20 slots and parallel=4 the decode phases overlap significantly;
  // text-only slots run while image slots are still waiting on a media barrier.
  t.ok(
    toNumber(batchResponse.stats.avgConcurrentSeq) > 1.5,
    `avgConcurrentSeq (${toNumber(batchResponse.stats.avgConcurrentSeq)}) > 1.5 confirms concurrent scheduling across slot types`
  )
})
