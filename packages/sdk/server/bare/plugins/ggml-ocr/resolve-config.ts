import {
  type OCRConfig,
  type ModelSrcInput,
  type ResolveContext,
  type ResolveResult
} from '@/schemas'
import { ModelLoadFailedError } from '@/utils/errors-server'
import { hyperdriveUrlSchema } from '@/schemas/load-model'
import { OCR_CRAFT, OCR_DOCTR_1 } from '@/models/registry'

type OcrPipelineType = NonNullable<OCRConfig['pipelineType']>

// Detector weights paired with each pipeline. EasyOCR runs CRAFT
// detection, DocTR runs DBNet detection — the addon cannot load one
// pipeline's detector into the other.
export const DETECTOR_FILENAMES: Record<OcrPipelineType, string> = {
  easyocr: 'craft_mlt_25k.gguf',
  doctr: 'db_mobilenet_v3_large.gguf'
}

const DETECTOR_REGISTRY_SOURCES: Record<OcrPipelineType, string> = {
  easyocr: OCR_CRAFT.src,
  doctr: OCR_DOCTR_1.src
}

// The addon defaults to the EasyOCR pipeline, so a DocTR recognizer
// loaded without an explicit `pipelineType` dies deep in the EasyOCR
// CRNN weight loader with a raw missing-tensor error (QVAC-22514).
// Recognize the known DocTR registry artifacts by name and opt in to
// the DocTR pipeline automatically.
function inferPipelineType(recognizerSrc: string): OcrPipelineType | undefined {
  const path = srcPathname(recognizerSrc)
  const filename = path.split('/').pop() ?? ''
  if (filename === 'crnn_mobilenet_v3_small.gguf' || path.includes('/gguf/doctr')) {
    return 'doctr'
  }
  return undefined
}

function srcPathname(src: string): string {
  return (src.split(/[?#]/)[0] ?? '').toLowerCase()
}

function srcToString(src: ModelSrcInput): string {
  return typeof src === 'string' ? src : src.src
}

// The registry still lists legacy `.onnx` OCR artifacts under the
// "@qvac/ocr-onnx" engine; the ggml-ocr addon can only open GGUF, so a
// raw "failed to open GGUF" surfaces mid-load. Fail fast with the
// supported configurations instead (QVAC-22514).
function assertGgufSource(src: string, role: 'recognizer' | 'detector'): void {
  if (!srcPathname(src).endsWith('.onnx')) return
  throw new ModelLoadFailedError(
    `ggml-ocr only loads GGUF models, but the ${role} source points to an ONNX file: ${src}. ` +
      'The .onnx OCR registry entries are legacy artifacts of the removed "onnx-ocr" engine. ' +
      'Supported registry configurations: EasyOCR (default) — modelSrc: OCR_LATIN.src (detector OCR_CRAFT auto-derived); ' +
      'DocTR — modelSrc: OCR_DOCTR.src (pipelineType and detector OCR_DOCTR_1 auto-derived).'
  )
}

function deriveDetectorSource(modelSrc: string, pipelineType: OcrPipelineType): string | undefined {
  if (modelSrc.startsWith('pear://')) {
    const { key } = hyperdriveUrlSchema.parse(modelSrc)
    return `pear://${key}/${DETECTOR_FILENAMES[pipelineType]}`
  }
  if (modelSrc.startsWith('registry://')) {
    return DETECTOR_REGISTRY_SOURCES[pipelineType]
  }
  return undefined
}

export async function resolveOcrConfig(
  cfg: OCRConfig,
  ctx: ResolveContext
): Promise<ResolveResult<Record<string, unknown>, 'detectorModelPath'>> {
  const { detectorModelSrc, ...ocrConfig } = cfg

  assertGgufSource(ctx.modelSrc, 'recognizer')

  const pipelineType = ocrConfig.pipelineType ?? inferPipelineType(ctx.modelSrc) ?? 'easyocr'

  const detectorSrc = detectorModelSrc ?? deriveDetectorSource(ctx.modelSrc, pipelineType)
  if (!detectorSrc) {
    throw new ModelLoadFailedError(
      `Detector model required for OCR (${pipelineType} pipeline expects ` +
        `${DETECTOR_FILENAMES[pipelineType]}). Use a hyperdrive or registry ` +
        'source, or provide detectorModelSrc'
    )
  }

  assertGgufSource(srcToString(detectorSrc), 'detector')

  const detectorModelPath = await ctx.resolveModelPath(detectorSrc)
  return {
    config: { ...ocrConfig, pipelineType },
    artifacts: { detectorModelPath }
  }
}
