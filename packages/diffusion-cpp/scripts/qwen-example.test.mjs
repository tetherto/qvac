import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const example = new URL('../examples/generate-image-qwen-21.js', import.meta.url)
const source = readFileSync(example, 'utf8')

async function captureRequest(size) {
  let request
  const errors = []
  const process = {
    env: {
      QWEN_TURBO: '1',
      QWEN_TURBO_MODEL: '/models/turbo.gguf',
      QWEN_WIDTH: String(size),
      QWEN_HEIGHT: String(size)
    },
    argv: ['bare', fileURLToPath(example), '--mode', 'text-to-image']
  }
  class Model {
    load() {
      return Promise.resolve()
    }
    unload() {
      return Promise.resolve()
    }
    run(params) {
      request = params
      return {
        onUpdate(callback) {
          callback(new Uint8Array([137, 80, 78, 71]))
          return this
        },
        await() {
          return Promise.resolve()
        }
      }
    }
  }
  const modules = {
    'bare-path': path,
    'bare-process': process,
    'bare-fs': { mkdirSync() {}, writeFileSync() {} },
    '../index': Model
  }
  await vm.runInNewContext(source, {
    __dirname: path.dirname(fileURLToPath(example)),
    Uint8Array,
    console: {
      log() {},
      error(error) {
        errors.push(error)
      }
    },
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`)
      return modules[name]
    }
  })
  assert.deepEqual(errors, [])
  assert.equal(process.exitCode, undefined)
  assert.ok(request)
  return request
}

test('Qwen 2K example splits VAE decoding into smaller native tiles', async () => {
  const request = await captureRequest(2048)
  assert.equal(request.vae_tiling, true)
  // Qwen-Image-2.1's VAE downsamples by sixteen. A tile must be smaller than the
  // latent grid to avoid the full-frame CUDA stride assertion at 2K.
  assert.ok(request.vae_tile_size >= 4)
  assert.ok(request.vae_tile_size < request.width / 16)
  assert.ok(request.vae_tile_size < request.height / 16)
})

test('Qwen smoke-size example retains untiled eight-step Turbo sampling', async () => {
  const request = await captureRequest(512)
  assert.notEqual(request.vae_tiling, true)
  assert.equal(request.steps, 8)
  assert.equal(request.cfg_scale, 1)
  assert.equal(request.custom_sigmas.length, 9)
  assert.equal(request.custom_sigmas.at(-1), 0)
})
