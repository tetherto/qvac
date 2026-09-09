'use strict'
const os = require('bare-os')
const { settings, clips, models, question } = require('./video-config.cjs')
const { extract, download, hashFile } = require('./video-core.cjs')

function emit(row) {
  console.log('[VIDEO-E2E] ' + JSON.stringify(row))
  return row
}

async function runInference(engine, frames, extraText = '') {
  // The existing addon prefixes media markers to the next user text turn. Keep
  // all frames in ONE turn; give an ordered timestamp index in the accompanying
  // text. This is the universal multi-image baseline, NOT native Qwen pairing.
  const messages = frames.map((f) => ({
    role: 'user',
    type: 'media',
    content: new Uint8Array(f.ppm)
  }))
  const index = frames.map((f, i) => `Frame ${i + 1}: ${f.ptsS.toFixed(3)} seconds.`).join(' ')
  messages.push({ role: 'user', content: extraText + '\n' + index + '\n' + question })
  let output = '',
    error = null,
    firstTokenMs = null
  const started = Date.now()
  const response = await engine.run(messages, {
    generationParams: { predict: settings.predictionTokens, reasoning_budget: 0 }
  })
  response
    .onUpdate((chunk) => {
      if (firstTokenMs === null && String(chunk).trim()) firstTokenMs = Date.now() - started
      output += chunk
    })
    .onError((err) => {
      error = err
    })
  await response.await()
  if (error) throw error
  const inferenceMs = Date.now() - started
  const stats = response.stats
  if (!output.trim() || !Number.isFinite(stats?.visionEncodeMs) || !Number.isFinite(stats?.TTFT)) {
    throw new Error('missing output or stage counters: ' + JSON.stringify(stats))
  }
  return {
    inferenceMs,
    firstTokenMs,
    visionEncodeMs: stats.visionEncodeMs,
    // Native TTFT is not an exclusive text-prefill timer. It can overlap vision.
    engineTTFTMs: stats.TTFT,
    remainingGenerationMs: firstTokenMs === null ? null : inferenceMs - firstTokenMs,
    generationEvalMs: stats.TPS > 0 ? (stats.generatedTokens * 1000) / stats.TPS : null,
    stats,
    output
  }
}

async function runBenchmark({ Llm, resolveModel, directory, onlyModel, smoke = false }) {
  const started = Date.now()
  const available = []
  emit({
    phase: 'start',
    platform: os.platform(),
    arch: os.arch(),
    settings,
    source:
      'QVAC 0.51.0 / main df467c721 / CI 34220546522 / fabric 10297.1.2; no native temporal pairing'
  })
  for (const clip of smoke ? clips.slice(0, 1) : clips) {
    const dl = await download(clip, directory)
    emit({ phase: 'download', clip: clip.id, ...dl, sha256: hashFile(dl.file), url: clip.url })
    available.push({ ...clip, ...dl })
  }
  const rows = []
  for (const model of models) {
    if (onlyModel && model.id !== onlyModel) continue
    const modelFiles = await resolveModel(model)
    const config = {
      device: 'gpu',
      gpu_layers: '98',
      ctx_size: String(settings.context),
      temp: '0',
      seed: '42',
      'reasoning-budget': '0',
      predict: String(settings.predictionTokens),
      'ubatch-size': '320',
      image_max_tokens: String(settings.imageMaxTokens),
      image_min_tokens: '70',
      verbosity: '2'
    }
    const engine = new Llm({
      files: { model: [modelFiles.model], projectionModel: modelFiles.projector },
      config,
      opts: { stats: true },
      logger: { info: () => {}, debug: () => {}, warn: console.warn, error: console.error }
    })
    try {
      const tLoad = Date.now()
      await engine.load()
      const loadMs = Date.now() - tLoad
      emit({ phase: 'load', model: model.id, loadMs, config, modelFiles })
      const warm = extract(available[0].file, 'full', { limitSeconds: 1, maxFrames: 1 })
      emit({ phase: 'warmup', model: model.id, ...(await runInference(engine, warm.frames)) })
      for (const clip of available) {
        for (const mode of ['full', 'key']) {
          const t0 = Date.now()
          const prepared = extract(clip.file, mode, { limitSeconds: clip.limitSeconds })
          const inference = await runInference(engine, prepared.frames)
          const e2eMs = Date.now() - t0
          rows.push(
            emit({
              phase: 'video',
              model: model.id,
              clip: clip.id,
              mode,
              platform: os.platform(),
              e2eMs,
              estimatedModelLoadPlusE2eMs: loadMs + e2eMs,
              preprocessing: prepared.record,
              ...inference
            })
          )
          if (smoke) break
        }
      }
      if (!smoke) {
        const one = warm.frames[0]
        for (const count of [1, 2, 4, 8, 16, 32]) {
          const frames = Array.from({ length: count }, (_, i) => ({ ...one, ptsS: i }))
          rows.push(
            emit({
              phase: 'scaling',
              model: model.id,
              frames: count,
              context: settings.context,
              ...(await runInference(engine, frames))
            })
          )
        }
        const frames = Array.from({ length: 8 }, (_, i) => ({ ...one, ptsS: i }))
        rows.push(
          emit({
            phase: 'longer-text',
            model: model.id,
            frames: 8,
            context: settings.context,
            extraWords: 2048,
            ...(await runInference(engine, frames, 'This is background context. '.repeat(410)))
          })
        )
        const t0 = Date.now()
        const burst = extract(available[0].file, 'all-short', { limitSeconds: 1, maxFrames: 64 })
        const inference = await runInference(engine, burst.frames)
        rows.push(
          emit({
            phase: 'all-frame-burst',
            model: model.id,
            clip: available[0].id,
            e2eMs: Date.now() - t0,
            preprocessing: burst.record,
            ...inference
          })
        )
      }
    } finally {
      await engine.unload()
    }
  }
  emit({ phase: 'done', rows: rows.length, totalMs: Date.now() - started })
  return rows
}

module.exports = { runInference, runBenchmark }
