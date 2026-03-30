'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

const { profileDownload } = require('../lib/profiler')

const REGISTRY_CORE_KEY = process.env.QVAC_REGISTRY_CORE_KEY
const STATS_INTERVAL_SEC = parseInt(process.env.PROFILE_INTERVAL || '5', 10)

function usage () {
  console.log(`
Usage: node profile-download.js [model-path] [source]

  model-path   Path of the model to download (omit to list available models)
  source       Source filter, e.g. "hf" or "s3" (default: first match)

Environment:
  QVAC_REGISTRY_CORE_KEY   Registry view core key (required)
  PROFILE_INTERVAL         Stats print interval in seconds (default: 5)

Examples:
  node profile-download.js
  node profile-download.js "ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin"
  PROFILE_INTERVAL=2 node profile-download.js "ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin" hf
`)
}

async function main () {
  if (!REGISTRY_CORE_KEY) {
    console.error('QVAC_REGISTRY_CORE_KEY is not set')
    process.exit(1)
  }

  const modelPath = process.argv[2]
  const sourceFilter = process.argv[3]

  if (modelPath === '--help' || modelPath === '-h') {
    usage()
    process.exit(0)
  }

  if (!modelPath) {
    usage()
    process.exit(0)
  }

  await profileDownload({
    registryCoreKey: REGISTRY_CORE_KEY,
    modelPath,
    source: sourceFilter,
    intervalSec: STATS_INTERVAL_SEC
  })
}

main().catch((err) => {
  console.error('Profiler failed:', err)
  process.exit(1)
})
