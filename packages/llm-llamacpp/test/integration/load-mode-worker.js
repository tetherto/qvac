'use strict'

// Worker for load-mode.test.js: loads one model under one load_mode in a fresh
// process and prints one JSON line. See that file for why each measurement
// needs its own process.
//
// Not a *.test.js file, so the integration glob does not pick it up.

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../../index.js')

const [modelPath, loadMode, device] = process.argv.slice(2)

function readMemory() {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8').split('\n')
    const readBytes = (key) => {
      const line = status.find((l) => l.startsWith(key))
      if (!line) return null
      const value = Number(line.replace(/[^0-9]/g, ''))
      return Number.isFinite(value) ? value * 1024 : null
    }
    return { anon: readBytes('RssAnon:'), file: readBytes('RssFile:') }
  } catch {
    return { anon: null, file: null }
  }
}

async function main() {
  const before = readMemory()

  const addon = new LlmLlamacpp({
    files: { model: [path.resolve(modelPath)] },
    config: {
      device,
      gpu_layers: device === 'gpu' ? '999' : '0',
      ctx_size: '512',
      n_predict: '8',
      load_mode: loadMode,
      verbosity: '0'
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    opts: { stats: true }
  })

  await addon.load()
  const after = readMemory()
  await addon.unload().catch(() => {})

  console.log(
    JSON.stringify({
      ok: true,
      loadMode,
      anonDelta: before.anon === null || after.anon === null ? null : after.anon - before.anon,
      fileDelta: before.file === null || after.file === null ? null : after.file - before.file
    })
  )
  process.exit(0)
}

main().catch((err) => {
  console.log(
    JSON.stringify({ ok: false, loadMode, error: err && err.message ? err.message : String(err) })
  )
  process.exit(1)
})
