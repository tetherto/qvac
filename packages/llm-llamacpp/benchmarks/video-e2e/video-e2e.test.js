'use strict'
const test = require('brittle')
const path = require('bare-path')
const os = require('bare-os')
const Llm = require('../../index.js')
const { ensureModel } = require('./utils')
const { runBenchmark } = require('./video-addon.cjs')

// Concrete names anchor the generated mobile pre-stage entry to this test.
// Qwen3.5-0.8B-Q8_0.gguf + mmproj-Qwen3.5-0.8B-F16.gguf
// google_gemma-4-E2B-it-Q4_K_M.gguf + mmproj-google_gemma-4-E2B-it-f16.gguf
const REQUIRED_MODELS = [
  'Qwen3.5-0.8B-Q8_0.gguf',
  'mmproj-Qwen3.5-0.8B-F16.gguf',
  'google_gemma-4-E2B-it-Q4_K_M.gguf',
  'mmproj-google_gemma-4-E2B-it-f16.gguf'
]

test('video e2e latency benchmark', { timeout: 1200000 }, async (t) => {
  const modelPaths = {}
  for (const modelName of REQUIRED_MODELS) {
    const [name, dir] = await ensureModel({ modelName })
    modelPaths[modelName] = path.join(dir, name)
  }
  const rows = await runBenchmark({
    Llm,
    resolveModel: (model) => ({
      model: modelPaths[model.modelName],
      projector: modelPaths[model.projectorName]
    }),
    directory: path.join(os.tmpdir(), 'qvac-video-e2e')
  })
  t.is(
    rows.filter((r) => r.phase === 'video').length,
    12,
    'all 3 clips x 2 modes x 2 models completed'
  )
  t.is(rows.filter((r) => r.phase === 'scaling').length, 12, 'both frame-count sweeps completed')
  t.is(
    rows.filter((r) => r.phase === 'all-frame-burst').length,
    2,
    'both all-frame bursts completed'
  )
  for (const row of rows) {
    t.ok(row.output.trim().length > 0, `${row.model} ${row.phase} returned text`)
    t.ok(row.visionEncodeMs > 0, 'real vision encoding measured')
    t.ok(row.stats.promptTokens > 0, 'prompt tokens measured')
    t.ok(row.firstTokenMs > 0 && row.firstTokenMs <= row.inferenceMs, 'valid wall-clock TTFT')
    if (row.preprocessing) {
      const p = row.preprocessing
      t.ok(p.retainedFrames > 0 && p.retainedFrames <= 64, 'bounded nonempty frame sample')
      t.ok(p.decodedFrames >= p.retainedFrames, 'samples come from decoded frames')
      t.ok(p.outputWidth <= 448 && p.outputHeight <= 448, 'bounded image resolution')
      t.ok(
        p.timestampsS.every((v, i, a) => i === 0 || v > a[i - 1]),
        'ordered timestamps'
      )
      if (row.clip === 'bbb-720p' && row.mode === 'full') {
        t.is(p.decodedFrames, 300, 'all frames including delayed B frames decoded')
        t.is(p.retainedFrames, 10, 'one sample per second from the 10-second clip')
      }
      if (row.phase === 'all-frame-burst') {
        t.is(p.retainedFrames, 30, 'all 30 frames from the one-second burst reach the VLM')
      }
    }
  }
})
