'use strict'

// End-to-end accuracy regression for the desktop GPU (Vulkan) path: every
// fixture must transcribe at least as well as the WER recorded in the manifest.
// Runs with use_gpu=true and falls back to CPU where no GPU is present. Set
// QVAC_BCI_WER_RELAX=1 to downgrade a bound miss to a warning.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const BCIWhispercpp = require('../../index')
const { getTestPaths, getModelPath, computeWER, detectPlatform } = require('./helpers')
const { flattenSegments } = require('@qvac/bci-whispercpp/util')

const { platform, label } = detectPlatform()
const { manifest, getSamplePath } = getTestPaths()

const MODEL_PATH =
  (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  getModelPath('ggml-bci-windowed.bin')
const EMBEDDER_PATH = path.join(path.dirname(MODEL_PATH), 'bci-embedder.bin')
const hasModel = fs.existsSync(MODEL_PATH)

const RELAX = os.hasEnv('QVAC_BCI_WER_RELAX') && os.getEnv('QVAC_BCI_WER_RELAX') === '1'

// Tolerance for the 4-decimal bci_wer stored in the manifest.
const WER_TOL = 1e-4

function backendIdToName(id) {
  return (
    { 0: 'CPU', 1: 'Metal', 2: 'CUDA', 3: 'Vulkan', 4: 'OpenCL', 99: 'other-GPU' }[id] ||
    'unknown(' + id + ')'
  )
}

function assertNoRegression(t, name, wer, bound) {
  const msg =
    name +
    ': WER ' +
    (wer * 100).toFixed(2) +
    '% must be <= ' +
    (bound * 100).toFixed(2) +
    '% (recorded good result)'
  if (wer <= bound + WER_TOL) {
    t.pass(msg)
  } else if (RELAX) {
    t.comment('WARNING (relaxed): ' + msg)
    t.pass(name + ': relaxed')
  } else {
    t.fail(msg)
  }
}

function pickTwoDistinctSamples(samples) {
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      if (samples[i].expected_text !== samples[j].expected_text) {
        return [samples[i], samples[j]]
      }
    }
  }
  return null
}

async function transcribeSampleOnGpu(sample) {
  const dayIdx = typeof sample.day_idx === 'number' ? sample.day_idx : -1
  const bci = new BCIWhispercpp(
    {
      files: { model: MODEL_PATH, embedder: EMBEDDER_PATH },
      opts: { stats: true }
    },
    {
      whisperConfig: { language: 'en', temperature: 0.0 },
      miscConfig: { caption_enabled: false },
      contextParams: { use_gpu: true },
      bciConfig: dayIdx >= 0 ? { day_idx: dayIdx } : undefined
    }
  )
  try {
    await bci.load()
    const response = await bci.transcribeFile(getSamplePath(sample.file))
    const output = await response.await()
    return flattenSegments(output)
      .map((s) => s.text)
      .join('')
      .trim()
  } finally {
    await bci.destroy()
  }
}

test(
  '[BCI][Vulkan-desktop] transcription accuracy has not regressed',
  { skip: !hasModel, timeout: 180000 },
  async (t) => {
    t.ok(manifest.samples.length > 0, 'Manifest must contain at least one sample')
    t.comment('Platform: ' + label + '   Model: ' + MODEL_PATH)

    // Group by day_idx so one loaded context serves all its samples.
    const byDay = new Map()
    for (const sample of manifest.samples) {
      const key = typeof sample.day_idx === 'number' ? sample.day_idx : -1
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key).push(sample)
    }

    const results = []
    let backendId = null

    for (const [day, samples] of byDay) {
      const bci = new BCIWhispercpp(
        {
          files: { model: MODEL_PATH, embedder: EMBEDDER_PATH },
          opts: { stats: true }
        },
        {
          whisperConfig: { language: 'en', temperature: 0.0 },
          miscConfig: { caption_enabled: false },
          contextParams: { use_gpu: true },
          bciConfig: day >= 0 ? { day_idx: day } : undefined
        }
      )

      try {
        await bci.load()
        for (const sample of samples) {
          const samplePath = getSamplePath(sample.file)
          if (!fs.existsSync(samplePath)) {
            t.fail('Fixture ' + sample.file + ' is missing')
            continue
          }
          const response = await bci.transcribeFile(samplePath)
          const output = await response.await()
          if (backendId === null && response.stats) backendId = response.stats.backendId

          const text = flattenSegments(output)
            .map((s) => s.text)
            .join('')
            .trim()
          const wer = computeWER(text, sample.expected_text)
          const bound = typeof sample.bci_wer === 'number' ? sample.bci_wer : 0
          results.push({ file: sample.file, wer, bound })

          t.comment(
            '[' +
              sample.file +
              '] expected=' +
              JSON.stringify(sample.expected_text) +
              ' got=' +
              JSON.stringify(text) +
              ' WER=' +
              (wer * 100).toFixed(2) +
              '% (bound ' +
              (bound * 100).toFixed(2) +
              '%)'
          )
        }
      } finally {
        await bci.destroy()
      }
    }

    t.comment('Active backend: backendId=' + backendId + ' (' + backendIdToName(backendId) + ')')
    // On desktop, a GPU that engaged must be Vulkan/CUDA, not a mislabelled
    // fallback. Genuine CPU fallback (backendId 0) is allowed; gpu-smoke owns
    // the "must engage GPU" gate.
    if ((platform === 'linux' || platform === 'win32') && backendId !== null && backendId !== 0) {
      t.ok(
        backendId === 3 || backendId === 2,
        'desktop GPU path should be Vulkan(3) or CUDA(2), got ' + backendIdToName(backendId)
      )
    }

    t.is(results.length, manifest.samples.length, 'All manifest samples were evaluated')

    for (const r of results) assertNoRegression(t, r.file, r.wer, r.bound)

    const avg = results.reduce((s, r) => s + r.wer, 0) / results.length
    const refAvg = results.reduce((s, r) => s + r.bound, 0) / results.length
    t.comment(
      'Average WER: ' +
        (avg * 100).toFixed(2) +
        '%  (recorded reference avg ' +
        (refAvg * 100).toFixed(2) +
        '%)'
    )
    assertNoRegression(t, 'average', avg, refAvg)
  }
)

// Focused guard for the neural-mel hand-off (whisper_set_mel + whisper_full with
// zero PCM samples). A skipped injection would run whisper on an empty/stale mel
// and produce no text; an ignored injection would collapse different inputs to
// the same output. Both failure modes are caught here.
test(
  '[BCI][Vulkan-desktop] neural mel is injected and consumed by whisper',
  { skip: !hasModel, timeout: 180000 },
  async (t) => {
    const pair = pickTwoDistinctSamples(manifest.samples)
    t.ok(pair, 'Manifest must contain two fixtures with different expected text')
    if (!pair) return

    const [first, second] = pair
    const firstText = await transcribeSampleOnGpu(first)
    const secondText = await transcribeSampleOnGpu(second)
    t.comment('[' + first.file + '] -> ' + JSON.stringify(firstText))
    t.comment('[' + second.file + '] -> ' + JSON.stringify(secondText))

    t.ok(
      firstText.length > 0 && secondText.length > 0,
      'Both fixtures produce non-empty text (mel was injected up-front)'
    )
    t.not(
      firstText,
      secondText,
      'Distinct neural inputs produce distinct transcriptions (mel is consumed)'
    )
  }
)
