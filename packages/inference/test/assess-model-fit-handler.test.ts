import test from 'brittle'

import { estimateTargetFor } from '@/handlers/assess-model-fit'
import { ModelType } from '@/schemas/index'

const CONSTANT = {
  src: 'registry://s3/models/model.gguf',
  name: 'MODEL',
  sha256Checksum: 'a'.repeat(64),
  registryPath: 'models/model.gguf',
  registrySource: 's3'
}

test('handler: a completion load is sized by the context its config carries', (t) => {
  const target = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.llamacppCompletion,
    modelConfig: { ctx_size: 8192 }
  })

  t.alike(target.workload, { kind: 'llm', contextTokens: 8192 })
  t.is(target.model.name, 'MODEL')
  t.is(target.model.sha256Checksum, CONSTANT.sha256Checksum)
  t.is(target.model.registryPath, CONSTANT.registryPath)
})

test('handler: a transcription load is sized by its audio window', (t) => {
  const target = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.whispercppTranscription,
    modelConfig: { duration_ms: 15_000, streaming: true }
  })

  t.alike(target.workload, { kind: 'audio', windowMs: 15_000, streaming: true })
})

test('handler: an audio load with no window declared takes the engine default', (t) => {
  const target = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.parakeetTranscription
  })

  t.alike(target.workload, { kind: 'audio', windowMs: 30_000, streaming: false })
})

// Without a checksum no resource profile resolves, which is what makes the
// estimator answer `unknown` rather than guess.
test('handler: a source outside the catalog carries no checksum', (t) => {
  const target = estimateTargetFor({
    modelSrc: '/models/local.gguf',
    modelType: ModelType.llamacppCompletion,
    modelConfig: { ctx_size: 4096 }
  })

  t.is(target.model.sha256Checksum, '')
  t.is(target.model.name, '/models/local.gguf')
})

test('handler: a load with no primary source is labelled by its model type', (t) => {
  const target = estimateTargetFor({
    modelType: ModelType.audiogenGgml,
    modelConfig: { lmModelSrc: CONSTANT, ditModelSrc: CONSTANT }
  })

  t.is(target.model.name, ModelType.audiogenGgml)
  t.is(target.model.sha256Checksum, '')
})

// The estimate sizes the whole set, so a companion the config carries is
// counted alongside the primary rather than silently dropped.
test('handler: companion sources in the config are counted', (t) => {
  const vad = { ...CONSTANT, name: 'VAD', sha256Checksum: 'b'.repeat(64) }

  const target = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.whispercppTranscription,
    modelConfig: { vadModelSrc: vad, vad_params: { threshold: 0.35 } }
  })

  t.is(target.artifacts?.length, 1)
  t.is(target.artifacts?.[0]?.name, 'VAD')
  t.is(target.artifacts?.[0]?.sha256Checksum, vad.sha256Checksum)
})

test('handler: the same companion named twice is counted once', (t) => {
  const target = estimateTargetFor({
    modelType: ModelType.audiogenGgml,
    modelConfig: { lmModelSrc: CONSTANT, ditModelSrc: CONSTANT }
  })

  t.is(target.artifacts?.length, 1)
})

// `duration_ms` is the longest clip a caller will transcribe. The engine
// chunks anything longer, so it never sizes working memory above one window.
test('handler: an audio window is capped at what the engine holds whole', (t) => {
  const target = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.whispercppTranscription,
    modelConfig: { duration_ms: 600_000 }
  })

  t.alike(target.workload, { kind: 'audio', windowMs: 30_000, streaming: false })
})

test('handler: an engine that names a device reports it verbatim', (t) => {
  const gpu = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.llamacppCompletion,
    modelConfig: { device: 'gpu' }
  })
  const cpu = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.llamacppEmbedding,
    modelConfig: { device: 'CPU' }
  })

  t.is(gpu.device, 'gpu')
  t.is(cpu.device, 'cpu', 'spelling is normalised, the value is not')
})

test('handler: a GPU switch resolves to a device, and defaults to the CPU', (t) => {
  const on = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.audiogenGgml,
    modelConfig: { useGPU: true }
  })
  const off = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.whispercppTranscription,
    modelConfig: {}
  })

  t.is(on.device, 'gpu')
  t.is(off.device, 'cpu')
})

test('handler: a switch is read where its own engine spells it', (t) => {
  const parakeet = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.parakeetTranscription,
    modelConfig: { useGPU: true }
  })
  const whisper = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.whispercppTranscription,
    modelConfig: { contextParams: { use_gpu: true } }
  })

  t.is(parakeet.device, 'gpu')
  t.is(whisper.device, 'gpu')
})

test('handler: bci holds the GPU unless its config turns it off', (t) => {
  const silent = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.bciWhispercppTranscription,
    modelConfig: {}
  })
  const off = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.bciWhispercppTranscription,
    modelConfig: { contextParams: { use_gpu: false } }
  })

  t.is(silent.device, 'gpu')
  t.is(off.device, 'cpu')
})

// `nGpuLayers` takes effect on its own and the config schema rejects it
// disagreeing with `useGPU`, so it is read first.
test('handler: tts reads its layer count ahead of its switch', (t) => {
  const layers = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.ttsGgml,
    modelConfig: { nGpuLayers: 99 }
  })
  const none = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.ttsGgml,
    modelConfig: { nGpuLayers: 0 }
  })

  t.is(layers.device, 'gpu')
  t.is(none.device, 'cpu')
})

test('handler: the engine is read off the source when the caller omits it', (t) => {
  const target = estimateTargetFor({
    modelSrc: { ...CONSTANT, engine: 'llamacpp-completion' },
    modelConfig: { ctx_size: 8192 }
  })

  t.alike(target.workload, { kind: 'llm', contextTokens: 8192 })
  t.is(target.device, 'gpu', 'the inferred engine decides how the config is read')
})

test('handler: a source naming its addon resolves the engine too', (t) => {
  const target = estimateTargetFor({
    modelSrc: { ...CONSTANT, addon: 'whisper' },
    modelConfig: { duration_ms: 15_000 }
  })

  t.alike(target.workload, { kind: 'audio', windowMs: 15_000, streaming: false })
})

test('handler: an explicit engine wins over the source', (t) => {
  const target = estimateTargetFor({
    modelSrc: { ...CONSTANT, engine: 'llamacpp-completion' },
    modelType: ModelType.llamacppEmbedding,
    modelConfig: {}
  })

  t.is(target.device, 'gpu')
  t.alike(target.workload, { kind: 'llm' }, 'the embedding arm sizes no context')
})

test('handler: a source naming no engine is refused', (t) => {
  t.exception(() => estimateTargetFor({ modelSrc: CONSTANT, modelConfig: {} }))
})

test('handler: an engine with no placement reports none', (t) => {
  const target = estimateTargetFor({
    modelSrc: CONSTANT,
    modelType: ModelType.nmtcppTranslation,
    modelConfig: {}
  })

  t.is(target.device, undefined)
})
