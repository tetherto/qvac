import test from 'brittle'
import { resolveOcrConfig } from '@/server/bare/plugins/ggml-ocr/resolve-config'
import { OCR_CRAFT, OCR_DOCTR, OCR_DOCTR_1, OCR_LATIN } from '@/models/registry'
import type { ModelSrcInput, OCRConfig, ResolveContext } from '@/schemas'
import { ModelLoadFailedError, PluginNotFoundError } from '@/utils/errors-server'

interface MockResolveCall {
  src: ModelSrcInput
}

function makeCtx(modelSrc: string): {
  ctx: ResolveContext
  calls: MockResolveCall[]
} {
  const calls: MockResolveCall[] = []
  const ctx: ResolveContext = {
    modelType: 'ggml-ocr',
    modelSrc,
    resolveModelPath: async (src: ModelSrcInput) => {
      calls.push({ src })
      const s = typeof src === 'string' ? src : src.src
      return `/tmp/cache/${s.replace(/[^a-zA-Z0-9.]/g, '_')}`
    }
  }
  return { ctx, calls }
}

async function resolve(modelSrc: string, cfg: OCRConfig = {}) {
  const { ctx, calls } = makeCtx(modelSrc)
  const result = await resolveOcrConfig(cfg, ctx)
  return { result, calls }
}

const PEAR_KEY = 'a'.repeat(64)

// Legacy ONNX artifact paths — still present in the live registry under
// engine "@qvac/ocr-onnx" but no longer exported as SDK constants.
const ONNX_DETECTOR_SRC =
  'registry://s3/qvac_models_compiled/ocr/doctr/2026-03-04/db_mobilenet_v3_large.onnx'

// ---------------------------------------------------------------------------
// QVAC-22514 Case A: DocTR recognizer loaded alone (per docs example) must
// select the DocTR pipeline and its DBNet detector, not the EasyOCR defaults.
// ---------------------------------------------------------------------------

test('resolveConfig: registry DocTR recognizer alone infers doctr pipeline + DBNet detector', async (t) => {
  const { result, calls } = await resolve(OCR_DOCTR.src)

  t.is(
    (result.config as OCRConfig).pipelineType,
    'doctr',
    'pipelineType inferred from the DocTR recognizer artifact'
  )
  t.is(calls.length, 1)
  t.is(
    calls[0]!.src,
    OCR_DOCTR_1.src,
    'detector auto-derived to db_mobilenet_v3_large.gguf (OCR_DOCTR_1)'
  )
})

test('resolveConfig: registry EasyOCR recognizer keeps easyocr pipeline + CRAFT detector', async (t) => {
  const { result, calls } = await resolve(OCR_LATIN.src)

  t.is((result.config as OCRConfig).pipelineType, 'easyocr')
  t.is(calls.length, 1)
  t.is(calls[0]!.src, OCR_CRAFT.src, 'detector auto-derived to CRAFT')
})

test('resolveConfig: explicit pipelineType wins over inference', async (t) => {
  const { result, calls } = await resolve(OCR_LATIN.src, {
    pipelineType: 'doctr'
  })

  t.is((result.config as OCRConfig).pipelineType, 'doctr')
  t.is(calls[0]!.src, OCR_DOCTR_1.src, 'detector follows the explicit pipeline')
})

test('resolveConfig: explicit detectorModelSrc is honored unchanged', async (t) => {
  const { calls } = await resolve(OCR_DOCTR.src, {
    detectorModelSrc: OCR_DOCTR_1.src
  })

  t.is(calls.length, 1)
  t.is(calls[0]!.src, OCR_DOCTR_1.src)
})

test('resolveConfig: pear:// source derives pipeline-matched detector filename', async (t) => {
  const doctr = await resolve(`pear://${PEAR_KEY}/crnn_mobilenet_v3_small.gguf`)
  t.is((doctr.result.config as OCRConfig).pipelineType, 'doctr')
  t.is(doctr.calls[0]!.src, `pear://${PEAR_KEY}/db_mobilenet_v3_large.gguf`)

  const easy = await resolve(`pear://${PEAR_KEY}/latin_g2.gguf`)
  t.is((easy.result.config as OCRConfig).pipelineType, 'easyocr')
  t.is(easy.calls[0]!.src, `pear://${PEAR_KEY}/craft_mlt_25k.gguf`)
})

test('resolveConfig: local path without detectorModelSrc fails with pipeline-specific hint', async (t) => {
  await t.exception(
    async () => resolve('/models/crnn_mobilenet_v3_small.gguf'),
    ModelLoadFailedError
  )
  try {
    await resolve('/models/crnn_mobilenet_v3_small.gguf')
    t.fail('expected ModelLoadFailedError')
  } catch (err) {
    t.ok(
      (err as Error).message.includes('db_mobilenet_v3_large.gguf'),
      'error names the detector the doctr pipeline expects'
    )
  }
})

// ---------------------------------------------------------------------------
// QVAC-22514 Cases B/C: legacy .onnx registry artifacts cannot be opened by
// the GGUF-only addon — fail fast with the supported configurations instead
// of a raw C++ GGUF open error.
// ---------------------------------------------------------------------------

test('resolveConfig: .onnx detectorModelSrc rejected with actionable error (Case B)', async (t) => {
  try {
    await resolve(OCR_DOCTR.src, {
      detectorModelSrc: ONNX_DETECTOR_SRC
    })
    t.fail('expected ModelLoadFailedError')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
    t.ok((err as Error).message.includes('only loads GGUF'))
    t.ok((err as Error).message.includes('OCR_DOCTR'), 'error names a supported configuration')
  }
})

test('resolveConfig: .onnx detector descriptor object rejected too', async (t) => {
  await t.exception(
    async () =>
      resolve(OCR_DOCTR.src, {
        detectorModelSrc: {
          src: ONNX_DETECTOR_SRC,
          modelId: 'db_mobilenet_v3_large.onnx'
        }
      }),
    ModelLoadFailedError
  )
})

test('resolveConfig: .onnx recognizer modelSrc rejected (Case C)', async (t) => {
  try {
    await resolve(ONNX_DETECTOR_SRC)
    t.fail('expected ModelLoadFailedError')
  } catch (err) {
    t.ok(err instanceof ModelLoadFailedError)
    t.ok((err as Error).message.includes('recognizer'))
  }
})

// ---------------------------------------------------------------------------
// QVAC-22514 Case D: removed onnx-ocr plugin gets a migration hint.
// ---------------------------------------------------------------------------

test('PluginNotFoundError: onnx-ocr carries a migration hint to ggml-ocr', (t) => {
  const err = new PluginNotFoundError('onnx-ocr')
  t.ok(err.message.includes('removed in @qvac/sdk 0.15.0'))
  t.ok(err.message.includes('ggml-ocr'))

  const other = new PluginNotFoundError('some-custom-type')
  t.ok(other.message.includes('custom worker bundle'))
})
