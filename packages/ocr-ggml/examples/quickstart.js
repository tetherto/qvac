'use strict'

/**
 * Quickstart — GGML-backed OCR.
 *
 *   bare examples/quickstart.js \
 *     --image samples/english.png \
 *     --detector models/craft_mlt_25k.gguf \
 *     --recognizer models/english_g2.gguf
 *
 * Environment overrides:
 *   OCR_GGML_DETECTOR     — path to CRAFT .gguf
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
  const args = { lang: 'en' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--image') args.image = next()
    else if (a === '--detector') args.detector = next()
    else if (a === '--recognizer') args.recognizer = next()
    else if (a === '--lang') args.lang = next()
    else if (a === '--paragraph') args.paragraph = true
    else if (a === '--mag-ratio') args.magRatio = parseFloat(next())
    else throw new Error(`unknown argument ${a}`)
  }
  return args
}

async function main () {
  const cli = parseArgs(process.argv)

  const image = cli.image || process.env.OCR_GGML_IMAGE || path.join(__dirname, '..', 'samples', 'english.png')
  const detector = cli.detector || process.env.OCR_GGML_DETECTOR || path.join(__dirname, '..', 'models', 'craft_mlt_25k.gguf')
  const recognizer = cli.recognizer || process.env.OCR_GGML_RECOGNIZER || path.join(__dirname, '..', 'models', 'english_g2.gguf')

  console.log('[quickstart] detector  =', detector)
  console.log('[quickstart] recognizer =', recognizer)
  console.log('[quickstart] image      =', image)

  const ocr = new OcrGgml({
    params: {
      pathDetector: detector,
      pathRecognizer: recognizer,
      langList: cli.lang.split(','),
      magRatio: cli.magRatio
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

    const stats = await response.await()
    if (stats) {
      console.log('[quickstart] stats =', stats)
    }
  } finally {
    await ocr.unload()
  }
}

main().catch(err => {
  console.error('[quickstart] failed:', err)
  process.exit(1)
})
