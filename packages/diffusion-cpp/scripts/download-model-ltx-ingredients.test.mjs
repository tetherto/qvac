import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const script = await readFile(resolve(scriptsDir, 'download-model-ltx-ingredients.sh'), 'utf8')

test('Ingredients downloader pins its gated adapter revision', () => {
  assert.match(script, /REPO="Lightricks\/LTX-2\.3-22b-IC-LoRA-Ingredients"/)
  assert.match(script, /REPO_REV="6cddbc81d57fea05d3ab20d580cc9839c148d982"/)
  assert.match(script, /MODEL="ltx-2\.3-22b-ic-lora-ingredients-0\.9\.safetensors"/)
  assert.doesNotMatch(script, /resolve\/main\//)
})

test('Ingredients downloader requires an access token', () => {
  assert.match(script, /HF_TOKEN is required because the Ingredients adapter is gated\./)
  assert.match(script, /dl "\$HF\/\$REPO\/resolve\/\$REPO_REV\/\$MODEL"/)
})
