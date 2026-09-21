'use strict'

/**
 * Backend device selection — CPU / Vulkan / Metal / OpenCL.
 *
 *   bare examples/backend-device.js \
 *     --backend metal \
 *     --image samples/english.png \
 *     --detector models/craft_mlt_25k.gguf \
 *     --recognizer models/english_g2.gguf
 *
 * Requesting a GPU backend opts in to GPU inference with transparent CPU
 * fallback: after `load()` the resolved device is reported by
 * `getBackendInfo()` (including a `fallbackReason` when the request could
 * not be honoured), and each run's stats carry the numeric `backendIsGpu`
 * flag. Use `--gpu-device N` to pin a specific GPU on multi-GPU hosts, and
 * `--pipeline-type doctr` to try the DocTR pipeline instead of EasyOCR.
 *
 * Environment overrides:
 *   OCR_GGML_DETECTOR     — path to detector .gguf
 *   OCR_GGML_RECOGNIZER   — path to recognizer .gguf
 *   OCR_GGML_IMAGE        — path to a JPEG/PNG/BMP test image
 *   VERBOSE=1             — forward C++ logs to console
 */

const path = require('bare-path')
const process = require('bare-process')
const OcrGgml = require('..').OcrGgml

const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true'

const logger = VERBOSE
  ? {
      info: (msg) => console.log('[C++ INFO]', msg),
      warn: (msg) => console.warn('[C++ WARN]', msg),
      error: (msg) => console.error('[C++ ERROR]', msg),
      debug: (msg) => console.log('[C++ DEBUG]', msg)
    }
  : null

function parseArgs (argv) {
  const args = { backend: 'cpu', pipelineType: 'easyocr' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--backend') args.backend = next()
    else if (a === '--gpu-device') args.gpuDevice = parseInt(next(), 10)
    else if (a === '--pipeline-type') args.pipelineType = next()
    else if (a === '--image') args.image = next()
    else if (a === '--detector') args.detector = next()
    else if (a === '--recognizer') args.recognizer = next()
    else throw new Error(`unknown argument ${a}`)
  }
  if (!['cpu', 'vulkan', 'metal', 'opencl'].includes(args.backend)) {
    throw new Error(`--backend must be cpu, vulkan, metal or opencl (got ${args.backend})`)
  }
  return args
}

async function main () {
  const cli = parseArgs(process.argv)

  const image = cli.image || process.env.OCR_GGML_IMAGE || path.join(__dirname, '..', 'samples', 'english.png')
  const detector = cli.detector || process.env.OCR_GGML_DETECTOR || path.join(__dirname, '..', 'models', 'craft_mlt_25k.gguf')
  const recognizer = cli.recognizer || process.env.OCR_GGML_RECOGNIZER || path.join(__dirname, '..', 'models', 'english_g2.gguf')

  console.log('[backend-device] backend    =', cli.backend)
  console.log('[backend-device] pipeline   =', cli.pipelineType)
  console.log('[backend-device] detector   =', detector)
  console.log('[backend-device] recognizer =', recognizer)
  console.log('[backend-device] image      =', image)

  const ocr = new OcrGgml({
    params: {
      pathDetector: detector,
      pathRecognizer: recognizer,
      langList: ['en'],
      pipelineType: cli.pipelineType,
      backendDevice: cli.backend,
      gpuDevice: cli.gpuDevice
    },
    opts: { stats: true },
    logger
  })

  await ocr.load()

  try {
    const info = ocr.getBackendInfo()
    console.log('[backend-device] resolved backend =', info)
    if (info && info.fallbackReason) {
      console.log('[backend-device] fell back to CPU:', info.fallbackReason)
    }

    const response = await ocr.run({ path: image })

    response.onUpdate(rows => {
      for (const [, text, conf] of rows) {
        console.log(`  [conf=${conf.toFixed(3)}] ${text}`)
      }
    })

    await response.await()
    const stats = response.stats
    if (stats && 'backendIsGpu' in stats) {
      console.log('[backend-device] stats =', stats)
      console.log('[backend-device] ran on', stats.backendIsGpu ? 'GPU' : 'CPU')
    }
  } finally {
    await ocr.unload()
  }
}

main().catch(err => {
  console.error('[backend-device] failed:', err)
  process.exit(1)
})
