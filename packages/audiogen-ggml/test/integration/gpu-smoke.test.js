'use strict'

// GPU / CPU backend smoke for @qvac/audiogen-ggml.
//
// The GPU leg is strict: a useGPU:true run that resolves to the CPU backend is
// treated as a regression. The engine degrades silently ("GPU requested but no
// GPU backend available; using CPU"), so without this gate a broken GPU build
// still reports green. CI sets NO_GPU=true on the CPU-only matrix entries and
// every NO_GPU=false entry runs on a dedicated GPU runner, so requiring a GPU
// whenever NO_GPU is false is safe. Set QVAC_AUDIOGEN_GPU_SMOKE_RELAX=1 to
// downgrade the gate to a warning.
//
// Both legs also check the audio is real, not merely present: a run returning
// the right number of *silent* samples satisfies `sampleCount > 0` yet is a
// miscompute. QVAC-22954 is the motivating case — a missing Vulkan CPY kernel.

const test = require('brittle')
const path = require('bare-path')
const proc = require('bare-process')
const { ensureAudiogenModels, getBaseDir } = require('../utils/downloadModel')
const {
  loadAudioGen,
  runAudioGen,
  backendIdToName,
  NO_GPU,
  INTEGRATION_TIMEOUT_MS
} = require('../utils/runAudioGen')

const VARIANT = 'turbo-q4'
const RELAX = proc.env && proc.env.QVAC_AUDIOGEN_GPU_SMOKE_RELAX === '1'

// Silence floors. A real 6 s render measures rms ~0.08-0.14 and peak ~0.9 (the
// addon normalises the peak to 0.9), so these leave a wide margin while still
// failing hard on an all-zero or near-zero buffer.
const MIN_PEAK = 0.1
const MIN_RMS = 0.005

const DURATION_S = 6

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

// Shape + loudness + length of a render, for either backend.
function assertAudio(t, data, tag) {
  t.is(data.channels, 2, `${tag}: stereo output`)
  t.is(data.sampleRate, 48000, `${tag}: 48 kHz output`)
  t.ok(data.sampleCount > 0, `${tag}: produced ${data.sampleCount} interleaved samples`)
  t.ok(
    data.peak > MIN_PEAK,
    `${tag}: audio is not silent (peak ${data.peak.toFixed(4)} > ${MIN_PEAK})`
  )
  t.ok(data.rms > MIN_RMS, `${tag}: audio carries energy (rms ${data.rms.toFixed(5)} > ${MIN_RMS})`)

  // The LM quantises the request into whole audio codes, so a render lands near
  // the requested length rather than on it (6 s -> ~5.6 s). Bound it loosely to
  // catch a truncated or runaway render without encoding the code grid.
  const requestedMs = DURATION_S * 1000
  t.ok(
    data.durationMs >= requestedMs * 0.5 && data.durationMs <= requestedMs * 1.5,
    `${tag}: duration ${Math.round(data.durationMs)} ms is within 50-150% of the requested ${requestedMs} ms`
  )
}

// Strict check that a useGPU:true run really executed on a GPU backend.
function assertRanOnGpu(t, stats) {
  if (!stats) {
    t.fail('GPU: no run stats returned, cannot verify which backend executed')
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  if (typeof dev !== 'number' || typeof id !== 'number') {
    t.fail(
      `GPU: stats carry no backendDevice/backendId (got ${dev}/${id}) — ` +
        'AcestepModel::runtimeStats() must report the resolved backend'
    )
    return
  }
  console.log(`[audiogen/GPU] backendDevice=${dev} backendId=${id} (${backendIdToName(id)})`)

  if (dev === 1) {
    t.pass(`GPU: ran on ${backendIdToName(id)} (backendId=${id})`)
    return
  }
  const msg =
    `GPU: expected a GPU backend, got ${backendIdToName(id)} ` +
    `(backendDevice=${dev}, backendId=${id}). useGPU:true was requested but the ` +
    'engine resolved to the CPU — a silent GPU fallback, not a passing run.'
  if (RELAX) {
    t.pass(`${msg} [relaxed via QVAC_AUDIOGEN_GPU_SMOKE_RELAX]`)
    return
  }
  t.fail(msg)
}

test(
  'GPU smoke: useGPU generation produces audio on a GPU backend',
  { timeout: INTEGRATION_TIMEOUT_MS, skip: NO_GPU },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable — run `npm run download-models:registry`.')
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: true
    })
    t.teardown(() => gen.destroy())

    const { data } = await runAudioGen(gen, {
      caption: 'cinematic orchestral, epic drums, rising strings',
      opts: { lyrics: '[Instrumental]', duration: DURATION_S, seed: 3 }
    })

    assertRanOnGpu(t, data.stats)
    assertAudio(t, data, 'GPU')
  }
)

test(
  'CPU contract: useGPU:false generation produces audio on the CPU backend',
  { timeout: INTEGRATION_TIMEOUT_MS },
  async (t) => {
    const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
    if (!download.success) {
      t.fail('ACE-Step models unavailable — run `npm run download-models:registry`.')
      return
    }

    const gen = await loadAudioGen({
      modelDir: download.modelDir,
      ditVariant: VARIANT,
      useGPU: false
    })
    t.teardown(() => gen.destroy())

    const { data } = await runAudioGen(gen, {
      caption: 'simple solo piano melody, sparse and gentle',
      opts: { lyrics: '[Instrumental]', duration: DURATION_S, seed: 4 }
    })

    if (data.stats && typeof data.stats.backendDevice === 'number') {
      t.is(data.stats.backendDevice, 0, 'CPU: useGPU:false resolved to the CPU backend')
    }
    assertAudio(t, data, 'CPU')
  }
)
