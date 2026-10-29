'use strict'

const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')
const TTSGgml = require('../../index')
const { ensureCosyvoiceModel, ensureSupertonicModel } = require('../utils/downloadModel')
const { getBaseDir } = require('../utils/runTTS')
const { NO_GPU, GPU_ONLY_USE_GPU } = require('../utils/gpuOnly')
const { TTS_TEST_THREADS } = require('../utils/testThreads')

async function collect(response) {
  let samples = 0
  let terminalCount = 0
  let tokenIds
  for await (const chunk of response.iterate()) {
    samples += chunk.outputArray.length
    if (chunk.isLast) terminalCount++
    if (chunk.speechTokenIds) tokenIds = chunk.speechTokenIds
  }
  return { samples, terminalCount, tokenIds }
}

test(
  'CosyVoice returns owned speech tokens and replays them through native streaming',
  { skip: NO_GPU },
  async (t) => {
    const download = await ensureCosyvoiceModel({
      targetDir: path.join(getBaseDir(), 'models', 'cosyvoice3')
    })
    t.ok(download.success, 'CosyVoice bundle is available')
    if (!download.success) return
    const model = new TTSGgml({
      engine: 'cosyvoice3',
      files: { cosyvoiceModelDir: download.modelDir },
      config: { useGPU: GPU_ONLY_USE_GPU },
      threads: TTS_TEST_THREADS,
      seed: 42,
      greedy: true,
      opts: { stats: true }
    })
    try {
      await model.load()
      const first = await collect(await model.run({ input: 'Hello from the speech addon.' }))
      t.ok(first.samples > 0, 'batch synthesis emits audio')
      t.ok(first.tokenIds.length > 0, 'batch synthesis returns its speech token trajectory')
      const retained = first.tokenIds.slice()
      await model.reload({ forceSpeechTokens: first.tokenIds, streamChunkTokens: 25 })
      const replay = await model.run({ input: 'Hello from the speech addon.' })
      const streamed = await collect(replay)
      t.ok(streamed.samples > 0, 'forced trajectory emits streamed audio')
      t.is(streamed.terminalCount, 1, 'streaming emits exactly one terminal chunk')
      t.alike(streamed.tokenIds, retained, 'returned IDs match the forced trajectory')
      t.alike(first.tokenIds, retained, 'a subsequent synthesis preserves the first result')
      t.is(replay.stats.speechTokens, retained.length, 'numeric speechTokens remains a count')
      t.is(replay.stats.totalSamples, streamed.samples, 'stream and stats account for the same PCM')
      await t.exception(
        model.reload({ forceSpeechTokens: [2147483647] }),
        /vocabulary/,
        'an out-of-vocabulary forced ID rejects without aborting the process'
      )
    } finally {
      await model.destroy()
    }
  }
)

test('Supertonic accepts precision controls and remains usable after warmUp', async (t) => {
  const download = await ensureSupertonicModel({ targetDir: path.join(getBaseDir(), 'models') })
  t.ok(download.success, 'Supertonic model is available')
  if (!download.success) return
  const model = new TTSGgml({
    engine: 'supertonic',
    files: { supertonicModel: download.path },
    config: { backend: 'cpu' },
    threads: TTS_TEST_THREADS,
    voice: 'F1',
    precision: 'f32',
    f16Weights: 0,
    f16Attn: 0,
    kvAttnType: 0
  })
  try {
    await model.load()
    t.is(
      await model.warmUp('Speech is ready.'),
      undefined,
      'warmUp completes without an audio response'
    )
    const result = await collect(await model.run({ input: 'Speech is ready.' }))
    t.ok(result.samples > 0, 'normal synthesis works after warmUp')
  } finally {
    await model.destroy()
  }
})

test(
  'Pocket preflight applies an explicit memory budget without loading a model',
  { skip: !proc.env.QVAC_POCKET_MODEL_DIR },
  async (t) => {
    const bundle = proc.env.QVAC_POCKET_MODEL_DIR
    const request = {
      engineType: 'pocket',
      pocketFlowModelPath: path.join(bundle, 'flow-lm.gguf'),
      pocketMimiModelPath: path.join(bundle, 'mimi.gguf'),
      pocketFrontendPath: path.join(bundle, 'frontend.json'),
      pocketVoicePath: path.join(bundle, 'voice.gguf'),
      backend: 'cpu',
      threads: TTS_TEST_THREADS,
      text: 'Project this sentence.'
    }
    const result = await TTSGgml.assessFit(request)
    t.is(result.status, 'fits', 'native metadata-only projection fits')
    t.ok(result.weightsBytes > 0, 'metadata accounts for weights')
    const constrained = await TTSGgml.assessFit({ ...request, memoryBudgetBytes: 1 })
    t.is(constrained.status, 'does-not-fit', 'application memory budget affects the projection')
    t.is(
      constrained.weightsBytes,
      result.weightsBytes,
      'the same metadata is used for both budgets'
    )
  }
)
