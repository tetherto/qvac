import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const script = await readFile(resolve(scriptsDir, 'download-model-flux2-ingredients.sh'), 'utf8')

test('FLUX.2 Ingredients downloader matches immutable manifest sources', () => {
  assert.match(
    script,
    /leejet\/FLUX\.2-klein-4B-GGUF\/resolve\/3b1f5a9dc3abb32238b053aeb3d823c30afdacbd\/flux-2-klein-4b-Q8_0\.gguf/
  )
  assert.match(
    script,
    /unsloth\/Qwen3-4B-GGUF\/resolve\/22c9fc8a8c7700b76a1789366280a6a5a1ad1120\/Qwen3-4B-Q4_K_M\.gguf/
  )
  assert.match(
    script,
    /black-forest-labs\/FLUX\.2-klein-4B\/resolve\/e7b7dc27f91deacad38e78976d1f2b499d76a294\/vae\/diffusion_pytorch_model\.safetensors/
  )
  assert.doesNotMatch(script, /resolve\/main\//)
  assert.doesNotMatch(script, /unsloth\/FLUX\.2-klein-4B-GGUF/)
})

test('FLUX.2 Ingredients downloader requires an access token', () => {
  assert.match(script, /HF_TOKEN is required because the FLUX\.2 VAE is gated\./)
})
