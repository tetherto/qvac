'use strict'
// Verifies that image_no_upscale is parsed from the addon config and actually
// reaches the vision encoder, by comparing prompt token counts across the three
// states of the flag.
//
// This guards the `common_params` -> `mtmd_context_params` hop in
// MtmdLlmContext::initVisionContext. That hop has failed silently once before:
// image_min_tokens / image_max_tokens were parsed into common_params and never
// copied across, so a caller-set value had no effect (see CHANGELOG 0.24.0).
// The unit tests in test/unit/test_load_config_handlers.cpp stop at
// common_params, so only an end-to-end token count can catch a dropped copy.
//
// Why VisionPsy Nano Flash and not SmolVLM2, which is already in the manifest:
// the override only applies to idefics3-style preprocessing, and SmolVLM2's
// mmproj declares no `clip.vision.preproc_image_size` cap. fabric rejects
// no-upscale against a missing cap (the cap is the upper bound of a std::clamp
// whose lower bound is image_size), so `on` would fail the load rather than
// change the encode. The VisionPsy Flash mmproj declares
// clip.vision.preproc_image_size = 2048, so both states are valid there.
//
// Why news-paper.jpg and not fruitPlate.png: the two sizing rules only differ
// below the cap. news-paper.jpg is 500x350, so its long side rounds up to a
// single 512 slice with the flag on, against a full grid stretched to 2048 with
// it off. fruitPlate.png is 2250x3000 and highRes3000x4000.jpg is larger still;
// both exceed the 2048 cap, where the two rules converge and the assertion
// would be vacuous.

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = { modelName: 'visionpsy-nano-460m-flash-q8_0.gguf' }
const PROJ_MODEL = { modelName: 'mmproj-visionpsy-nano-460m-flash-q8.gguf' }

function createLogger() {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

test(
  'image_no_upscale: prompt token counts reflect the preprocessing rule and the model default',
  { timeout: 1_800_000 },
  async (t) => {
    const [modelName, dirPath] = await ensureModel(MODEL)
    const [projModelName] = await ensureModel(PROJ_MODEL)
    const modelPath = path.join(dirPath, modelName)
    const projectionModelPath = path.join(dirPath, projModelName)

    const imageFilePath = getMediaPath('news-paper.jpg')
    t.ok(fs.existsSync(imageFilePath), 'news-paper.jpg image file should exist')
    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

    const baseConfig = {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '98',
      ctx_size: '8192',
      temp: '0',
      seed: '42',
      verbosity: '2'
    }

    // `extra` is spread last so passing {} exercises the absent-key path, which
    // must leave fabric's -1 sentinel alone rather than defaulting to 0/off.
    async function runWith(extra) {
      const inference = new LlmLlamacpp({
        files: { model: [modelPath], projectionModel: projectionModelPath },
        config: { ...baseConfig, ...extra },
        logger: createLogger(),
        opts: { stats: true }
      })
      await inference.load()
      try {
        const messages = [
          { role: 'user', type: 'media', content: imageBytes },
          { role: 'user', content: 'Describe the image briefly in one sentence.' }
        ]
        const response = await inference.run(messages)
        const chunks = []
        response.onUpdate((data) => {
          chunks.push(data)
        })
        await response.await()
        return { promptTokens: response.stats?.promptTokens ?? 0, output: chunks.join('') }
      } finally {
        await inference.unload().catch(() => {})
      }
    }

    const off = await runWith({ 'image-no-upscale': 'off' })
    t.comment(`off: promptTokens=${off.promptTokens}`)

    const on = await runWith({ 'image-no-upscale': 'on' })
    t.comment(`on: promptTokens=${on.promptTokens}`)

    const unset = await runWith({})
    t.comment(`unset: promptTokens=${unset.promptTokens}`)

    // Direction: with the flag on, a 500x350 image stays one 512 slice instead
    // of being stretched to the 2048 cap and sliced into a grid.
    t.ok(
      on.promptTokens < off.promptTokens,
      `on (${on.promptTokens}) should encode fewer prompt tokens than off (${off.promptTokens}); the flag is not reaching the encoder if these are equal`
    )

    // Magnitude: the measured ratio for a sub-cap image is several-fold (fabric
    // reports 858 -> 208 tokens at 640x480 and 1118 -> 78 at 256x256). Assert
    // only 2x so the test tracks the mechanism rather than a specific tile count.
    t.ok(
      on.promptTokens * 2 < off.promptTokens,
      `on (${on.promptTokens}) should be well under half of off (${off.promptTokens}); a small difference suggests the value is being clamped rather than applied`
    )

    // Tri-state: the published Flash mmproj carries no clip.vision.preproc_no_upscale
    // key, so the model default is off. Omitting the config key must therefore
    // land on exactly the off result -- not on 0/off by accident, which is what a
    // zero-initialised mtmd_context_params would give, and not on on.
    t.is(
      unset.promptTokens,
      off.promptTokens,
      `omitting the key (${unset.promptTokens}) should match explicit off (${off.promptTokens}); the -1 model default is not being preserved otherwise`
    )

    t.ok(off.output.length > 0, 'off mode produced output')
    t.ok(on.output.length > 0, 'on mode produced output')
    t.ok(unset.output.length > 0, 'unset mode produced output')
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
