import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const example = new URL('../examples/generate-image-fibo2-edit-turbo.js', import.meta.url)
const source = readFileSync(example, 'utf8')

async function runExample(args, env = {}, failRun = false) {
  const result = { errors: [], loaded: false, unloaded: false, inputs: [], writes: [] }
  const process = { env, argv: ['bare', fileURLToPath(example), ...args] }
  class Model {
    constructor(options) {
      result.options = options
    }
    load() {
      result.loaded = true
      return Promise.resolve()
    }
    unload() {
      result.unloaded = true
      return Promise.resolve()
    }
    run(params) {
      if (failRun) throw new Error('fixture generation failure')
      result.request = params
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
    'bare-fs': {
      existsSync: () => true,
      readFileSync(file) {
        result.inputs.push(file)
        return Buffer.from(file)
      },
      mkdirSync() {},
      writeFileSync(file, data) {
        result.writes.push({ file, data })
      }
    },
    '../index': Model
  }
  await vm.runInNewContext(source, {
    __dirname: path.dirname(fileURLToPath(example)),
    Uint8Array,
    console: { log() {}, error: (error) => result.errors.push(error) },
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`)
      return modules[name]
    }
  })
  return { ...result, exitCode: process.exitCode }
}

test('single-reference editing maps the downloaded files and uses four-step sampling', async () => {
  const result = await runExample(['portrait.png'], { FIBO_MODELS_DIR: '/models/fibo' })
  assert.deepEqual(result.errors, [])
  assert.equal(result.options.files.model, '/models/fibo/fibo2_edit_turbo-q4_0.gguf')
  assert.equal(result.options.files.llm, '/models/fibo/Qwen3VL-4B-Instruct-Q4_K_M.gguf')
  assert.equal(result.options.files.llmVision, '/models/fibo/mmproj-Qwen3VL-4B-Instruct-F16.gguf')
  assert.equal(result.options.files.vae, '/models/fibo/vae/flux2-vae.safetensors')
  assert.equal(result.request.init_image.toString(), path.resolve('portrait.png'))
  assert.equal(result.request.init_images, undefined)
  assert.equal(result.request.steps, 4)
  assert.equal(result.request.cfg_scale, 1)
  assert.equal(result.request.sampling_method, 'euler')
  assert.equal(result.request.scheduler, 'flux')
  assert.equal(result.request.custom_sigmas, undefined)
  assert.equal(result.writes.length, 1)
  assert.equal(result.unloaded, true)
})

test('multiple references retain their order and use only init_images', async () => {
  const refs = ['one.png', 'two.png', 'three.png', 'four.png']
  const result = await runExample(refs, { FIBO_PROMPT: 'Combine the four references.' })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(
    Array.from(result.request.init_images, (image) => image.toString()),
    refs.map((file) => path.resolve(file))
  )
  assert.equal(result.request.init_image, undefined)
  assert.equal(result.request.prompt, 'Combine the four references.')
})

test('invalid references or dimensions fail before loading the native model', async () => {
  for (const [args, env] of [
    [[], {}],
    [Array(5).fill('image.png'), {}],
    [['image.png'], { FIBO_WIDTH: '513' }]
  ]) {
    const result = await runExample(args, env)
    assert.equal(result.exitCode, 1)
    assert.equal(result.loaded, false)
    assert.equal(result.writes.length, 0)
  }
})

test('generation failures unload the model without writing an output', async () => {
  const result = await runExample(['image.png'], {}, true)
  assert.equal(result.exitCode, 1)
  assert.equal(result.unloaded, true)
  assert.equal(result.writes.length, 0)
  assert.match(result.errors[0].message, /fixture generation failure/)
})
