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
