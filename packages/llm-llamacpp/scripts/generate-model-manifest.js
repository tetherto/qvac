'use strict'
// Generate test/mobile/model-manifest.json: a map of mobile test function name
// (e.g. "runGemma4Test") -> array of { name, url } model descriptors used by
// that test. The Android Device Farm pre-stage step (host pre_test phase) reads
// this to fetch only the models a shard needs and `adb push` them to the
// device, so the phone never downloads from huggingface.co. Static-URL models
// (every functional test) are captured; dynamically-constructed URLs (perf
// benchmark shards) are skipped — they are not part of the functional shards.
const fs = require('fs')
const path = require('path')

const integrationDir = path.resolve(__dirname, '../test/integration')
const outPath = path.resolve(__dirname, '../test/mobile/model-manifest.json')

// Mirror toFunctionName() in generate-mobile-integration-tests.js:
// "gemma4.test.js" -> "runGemma4Test".
function toFunctionName (fileName) {
  const base = fileName.replace(/\.js$/, '')
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const suffix = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return `run${suffix}`
}

// Pull every { name|modelName: '...', url|downloadUrl: '...gguf...' } pair from a
// file, tolerating either key order. Returns deduped { name, url } objects.
function extractModels (src) {
  const found = new Map()
  const nameKey = "(?:name|modelName):\\s*'([^']+)'"
  const urlKey = "(?:url|downloadUrl):\\s*'(https?:\\/\\/[^']+?\\.gguf[^']*)'"
  const patterns = [
    new RegExp(`${nameKey}[^}]*?${urlKey}`, 'g'), // name before url
    new RegExp(`${urlKey}[^}]*?${nameKey}`, 'g') // url before name
  ]
  for (let i = 0; i < patterns.length; i++) {
    let m
    while ((m = patterns[i].exec(src)) !== null) {
      const name = i === 0 ? m[1] : m[2]
      const url = i === 0 ? m[2] : m[1]
      if (name && url) found.set(name, { name, url })
    }
  }
  return [...found.values()]
}

// Read a file, returning '' if missing.
function readIfExists (p) {
  try { return fs.readFileSync(p, 'utf8') } catch (_) { return '' }
}

// Models declared directly in the test file PLUS those in any local helper it
// requires (e.g. image tests get their model config from _image-common.js).
function modelsForFile (file) {
  const found = new Map()
  const add = (models) => models.forEach((m) => found.set(m.name, m))
  const src = readIfExists(path.join(integrationDir, file))
  add(extractModels(src))
  // Follow require('./_helper(.js)') — local shared helpers hold model configs.
  const reqRe = /require\('\.\/(_[\w-]+?)(?:\.js)?'\)/g
  let r
  while ((r = reqRe.exec(src)) !== null) {
    add(extractModels(readIfExists(path.join(integrationDir, `${r[1]}.js`))))
  }
  return [...found.values()]
}

function main () {
  const files = fs.readdirSync(integrationDir).filter((f) => f.endsWith('.test.js'))
  const manifest = {}
  let totalModels = 0
  for (const file of files) {
    const models = modelsForFile(file)
    if (models.length > 0) {
      manifest[toFunctionName(file)] = models
      totalModels += models.length
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    `[model-manifest] wrote ${Object.keys(manifest).length} tests, ` +
      `${totalModels} model refs -> ${path.relative(process.cwd(), outPath)}`
  )
}

main()
