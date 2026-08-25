'use strict'

/**
 * DocTR pipeline — DBNet detector + doctr CRNN recognizer.
 *
 *   bare examples/doctr.js \
 *     --image samples/english.png \
 *     --detector models/db_mobilenet_v3_large.gguf \
 *     --recognizer models/crnn_mobilenet_v3_small.gguf
 *
 * DocTR is language-agnostic: unlike the EasyOCR pipeline it needs no
 * `langList` (and ignores `magRatio` and the contrast-retry / rotation
 * knobs).
 *
 * Environment overrides:
 *   OCR_GGML_DOCTR_DETECTOR    — path to DBNet .gguf
 *   OCR_GGML_DOCTR_RECOGNIZER  — path to doctr CRNN .gguf
 *   OCR_GGML_IMAGE             — path to a JPEG/PNG/BMP test image
 *   VERBOSE=1                  — forward C++ logs to console
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
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--image') args.image = next()
    else if (a === '--detector') args.detector = next()
    else if (a === '--recognizer') args.recognizer = next()
    else if (a === '--paragraph') args.paragraph = true
    else throw new Error(`unknown argument ${a}`)
  }
  return args
}

async function main () {
  const cli = parseArgs(process.argv)

  const image = cli.image || process.env.OCR_GGML_IMAGE || path.join(__dirname, '..', 'samples', 'english.png')
  const detector = cli.detector || process.env.OCR_GGML_DOCTR_DETECTOR || path.join(__dirname, '..', 'models', 'db_mobilenet_v3_large.gguf')
  const recognizer = cli.recognizer || process.env.OCR_GGML_DOCTR_RECOGNIZER || path.join(__dirname, '..', 'models', 'crnn_mobilenet_v3_small.gguf')

  console.log('[doctr] detector   =', detector)
  console.log('[doctr] recognizer =', recognizer)
  console.log('[doctr] image      =', image)

  const ocr = new OcrGgml({
    params: {
      pathDetector: detector,
      pathRecognizer: recognizer,
      pipelineType: 'doctr'
    },
    opts: { stats: true },
    logger
  })

  await ocr.load()

  try {
    const response = await ocr.run({
      path: image,
      options: { paragraph: !!cli.paragraph }
    })

    response.onUpdate(rows => {
      for (const [box, text, conf] of rows) {
        const tag = `conf=${conf.toFixed(3)}`
        const xy = box.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join(' ')
        console.log(`  [${tag}] box=[${xy}] text=${text}`)
      }
    })

    await response.await()
    const stats = response.stats
    if (stats && 'totalTime' in stats) {
      console.log('[doctr] stats =', stats)
    }
  } finally {
    await ocr.unload()
  }
}

main().catch(err => {
  console.error('[doctr] failed:', err)
  process.exit(1)
})
