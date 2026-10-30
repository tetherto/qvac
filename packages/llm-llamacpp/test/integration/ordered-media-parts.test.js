'use strict'
// An ordered `content` array renders text and media inside ONE user turn, the
// shape llama-server produces for an OpenAI content-parts request. Without it
// the only way to interleave images and text is one message per part, which
// keeps their order but splits the turn: the model then sees three user
// messages instead of one, so text that refers to "this image" sits in a
// different turn from the image.
//
// Both media forms are covered: a path part and a byte-buffer part. The byte
// form exercises the JS hoist (bytes travel in the leading media messages, the
// part left behind is path-less) and must render the same prompt as the path
// form.

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
const { setLogger, releaseLogger } = require('../../addonLogging.js')
const { ensureModel, getMediaPath } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = { modelName: 'visionpsy-nano-460m-q8_0.gguf' }
const PROJ_MODEL = { modelName: 'mmproj-visionpsy-nano-460m-q8.gguf' }

function createLogger() {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

function userBlocks(formattedPrompt) {
  return Array.from(
    formattedPrompt.matchAll(/<\|im_start\|>user\n([\s\S]*?)<\|im_end\|>/g),
    (match) => match[1]
  )
}

test(
  'ordered content parts render as one user turn with inline media markers',
  { timeout: 1_800_000 },
  async (t) => {
    const [modelName, dirPath] = await ensureModel(MODEL)
    const [projModelName] = await ensureModel(PROJ_MODEL)
    const modelPath = path.join(dirPath, modelName)
    const projectionModelPath = path.join(dirPath, projModelName)

    const imageAPath = getMediaPath('news-paper.jpg')
    const imageBPath = getMediaPath('elephant.jpg')
    t.ok(fs.existsSync(imageAPath), 'news-paper.jpg image file should exist')
    t.ok(fs.existsSync(imageBPath), 'elephant.jpg image file should exist')
    const imageABytes = new Uint8Array(fs.readFileSync(imageAPath))
    const imageBBytes = new Uint8Array(fs.readFileSync(imageBPath))

    // `verbosity: '3'` is what makes the native layer log the rendered prompt.
    const model = new LlmLlamacpp({
      files: { model: [modelPath], projectionModel: projectionModelPath },
      config: {
        device: useCpu ? 'cpu' : 'gpu',
        gpu_layers: '98',
        threads: '4',
        ctx_size: '8192',
        temp: '0',
        predict: '1',
        reasoning_budget: '0',
        verbosity: '3',
        image_tile_mode: 'disabled'
      },
      logger: createLogger(),
      opts: { stats: true }
    })
    await model.load()

    let formattedPrompt = ''
    setLogger(function (priority, message) {
      const prefix = 'formatted prompt:'
      if (message.includes(prefix)) {
        formattedPrompt = message.slice(message.indexOf(prefix) + prefix.length).trim()
      }
    })

    try {
      async function runAndCapture(messages) {
        formattedPrompt = ''
        const response = await model.run(messages)
        const chunks = []
        response.onUpdate((data) => chunks.push(data))
        await response.await()
        return { prompt: formattedPrompt, output: chunks.join(''), stats: response.stats }
      }

      const expected = 'Image A:<__media__>Image B:<__media__>Compare.'

      // 1. The requested shape: one user message, media parts at their position.
      const fromPaths = await runAndCapture([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Image A:' },
            { type: 'media', content: imageAPath },
            { type: 'text', text: 'Image B:' },
            { type: 'media', content: imageBPath },
            { type: 'text', text: 'Compare.' }
          ]
        }
      ])

      t.alike(
        userBlocks(fromPaths.prompt),
        [expected],
        'path parts must render as one user turn with inline markers'
      )
      t.ok(fromPaths.output.length > 0, 'path-part request produced output')

      // 2. Same parts with raw bytes: the JS layer hoists the bytes but the
      // native plan must still bind them to the markers in this order.
      const fromBytes = await runAndCapture([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Image A:' },
            { type: 'media', content: imageABytes },
            { type: 'text', text: 'Image B:' },
            { type: 'media', content: imageBBytes },
            { type: 'text', text: 'Compare.' }
          ]
        }
      ])

      t.alike(
        userBlocks(fromBytes.prompt),
        [expected],
        'byte parts must render the same prompt as path parts'
      )
      t.ok(fromBytes.output.length > 0, 'byte-part request produced output')

      // 3. The pre-parts workaround: one message per part keeps the order but
      // splits the turn. Pinned so a change that silently merges turns (or
      // drops the ordering) is caught.
      const fromMessages = await runAndCapture([
        { role: 'user', content: 'Image A:' },
        { role: 'user', type: 'media', content: imageABytes },
        { role: 'user', content: 'Image B:' },
        { role: 'user', type: 'media', content: imageBBytes },
        { role: 'user', content: 'Compare.' }
      ])

      t.alike(
        userBlocks(fromMessages.prompt),
        ['Image A:', '<__media__>Image B:', '<__media__>Compare.'],
        'separate media messages still split the turn, as before'
      )
    } finally {
      releaseLogger()
      await model.unload().catch(() => {})
    }
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
