import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptsDir, '..')
const script = await readFile(resolve(scriptsDir, 'download-model-ltx.sh'), 'utf8')
const manifest = JSON.parse(
  await readFile(resolve(packageDir, 'test/integration/models.manifest.json'), 'utf8')
)

const defaultModel = 'LTX-2.3-22B-distilled-1.1-Q2_K.gguf'
const defaultLlm = 'gemma-3-12b-it-UD-Q2_K_XL.gguf'

function revisionFromManifest(modelName) {
  const url = new URL(manifest.models[modelName].urls[0])
  const parts = url.pathname.split('/')
  return parts[parts.indexOf('resolve') + 1]
}

test('LTX downloader defaults match integrity-pinned smoke-test models', () => {
  assert.match(script, /QUANTIZATIONS=\("Q2_K"\)/)
  assert.match(script, new RegExp(`GEMMA_FILE="\\$\\{GEMMA_FILE:-${defaultLlm}\\}"`))
  assert.equal(manifest.models[defaultModel].group, 'ltx')
  assert.equal(manifest.models[defaultLlm].group, 'ltx')
})

test('LTX downloader uses manifest revisions instead of mutable URLs', () => {
  assert.match(script, new RegExp(`REPO_REV="${revisionFromManifest(defaultModel)}"`))
  assert.match(script, new RegExp(`GEMMA_REPO_REV="${revisionFromManifest(defaultLlm)}"`))
  assert.match(
    script,
    new RegExp(
      `UNSLOTH_LTX_REV="${revisionFromManifest('ltx-2.3-22b-distilled_video_vae.safetensors')}"`
    )
  )
  assert.doesNotMatch(script, /resolve\/main\//)
})
