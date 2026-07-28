'use strict'

// Desktop integration-test model helper for @qvac/audiogen-ggml.
//
// The addon never downloads — it takes local paths. This util plays the app's
// role for the integration suite: it makes sure the four ACE-Step GGUFs for a
// DiT variant are on disk (checking a couple of candidate dirs first), fetching
// any missing ones from the QVAC model registry. Registry paths + filenames
// come from the addon's own manifest (../../models.js) so this stays in sync.
//
// Graceful-skip contract (mirrors tts-ggml/test/utils/downloadModel.js):
// @qvac/registry-client is lazily required, so a machine without it (or offline)
// gets `{ success: false }` and the tests fail with a clear "run
// npm run download-models:registry" message rather than a cryptic crash.

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const {
  REGISTRY_SOURCE,
  DEFAULT_DIT_VARIANT,
  modelFilenames,
  modelManifest
} = require('../../models.js')

// On desktop this is '.', so `models/` resolves relative to the package CWD
// (packages/audiogen-ggml). On-device runners set global.testDir.
function getBaseDir() {
  return typeof global !== 'undefined' && global.testDir ? global.testDir : '.'
}

// Directories searched for an already-present model set, in order: an explicit
// env override, then the package's own ./models (where download-models:registry
// puts them).
function candidateDirs() {
  const dirs = []
  const envDir = proc.env.AUDIOGEN_GGML_LOCAL_MODELS_DIR
  if (envDir) dirs.push(envDir)
  dirs.push(path.join(getBaseDir(), 'models'))
  return dirs
}

function fileOk(p) {
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

function hasAllIn(dir, filenames) {
  return filenames.every((name) => fileOk(path.join(dir, name)))
}

// The four stage filenames (bare names) for a DiT variant.
function expectedModelFiles(variant = DEFAULT_DIT_VARIANT) {
  const f = modelFilenames(variant)
  return [f.textEnc, f.lm, f.dit, f.vae]
}

async function downloadFromRegistry(registryPath, dest) {
  let QVACRegistryClient
  try {
    ;({ QVACRegistryClient } = require('@qvac/registry-client'))
  } catch {
    return false
  }
  const client = new QVACRegistryClient()
  try {
    await client.ready()
    await client.downloadModel(registryPath, REGISTRY_SOURCE, {
      outputFile: dest,
      timeout: 1800000
    })
  } catch {
    return false
  } finally {
    try {
      await client.close()
    } catch {}
  }
  return fileOk(dest)
}

// Ensure the four GGUFs for `variant` exist. Returns
// { success, modelDir, results }. `success` is true iff all four are present
// (already cached or freshly fetched); `modelDir` is the folder to hand the
// addon as `files.modelDir`.
async function ensureAudiogenModels({ targetDir, variant = DEFAULT_DIT_VARIANT } = {}) {
  const filenames = expectedModelFiles(variant)

  for (const dir of candidateDirs()) {
    if (hasAllIn(dir, filenames)) {
      return { success: true, modelDir: dir, results: [] }
    }
  }

  const outDir = targetDir || path.join(getBaseDir(), 'models')
  fs.mkdirSync(outDir, { recursive: true })

  const manifest = modelManifest(variant)
  const entries = [
    { name: filenames[0], registryPath: manifest.textEnc },
    { name: filenames[1], registryPath: manifest.lm },
    { name: filenames[2], registryPath: manifest.dit },
    { name: filenames[3], registryPath: manifest.vae }
  ]

  const results = []
  for (const entry of entries) {
    const dest = path.join(outDir, entry.name)
    if (fileOk(dest)) {
      results.push({ name: entry.name, ok: true, cached: true })
      continue
    }
    const ok = await downloadFromRegistry(entry.registryPath, dest)
    results.push({ name: entry.name, ok, cached: false })
  }

  const success = results.every((r) => r.ok)
  return { success, modelDir: outDir, results }
}

module.exports = {
  getBaseDir,
  expectedModelFiles,
  ensureAudiogenModels
}
