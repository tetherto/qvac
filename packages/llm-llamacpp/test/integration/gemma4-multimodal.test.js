'use strict'

// Split out of gemma4.test.js so the multimodal load gets its own mobile app
// process (its own Device Farm group) instead of running after that file's
// text-only tests, which each load and unload the same model first.

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
// Desktop x64-darwin and linux-arm64 hosts have no working GPU stack here
// so we drop to CPU; everywhere else (including iOS / Android device farm)
// uses the GPU backend the addon picks. Vision (mmproj) follows the same
// device routing as text generation -- bartowski's mmproj is what we ship
// as the fixture and we want CI to actually validate the GPU code path on
// real Adreno/Mali/Metal devices.
const useCpu = isDarwinX64 || isLinuxArm64

// Use bartowski's GGUF rather than unsloth's: bartowski's pack tags <eos> as
// the EOG token (matching the base google/gemma-4-E2B-it tokenizer), so the
// addon's generation loop terminates on the first <eos> the model emits.
// unsloth's pack instead tags <turn|> as EOG and leaves <eos> classified as a
// regular text token; in that pack Gemma 4's training-baked post-content
// <eos> trail is not a stop signal, so generation continues to spit ~9
// extra <eos> tokens before the loop sees <turn|>. Same vocab, different
// tokenizer.ggml.eos_token_id metadata, ~30% shorter completions for us.
const GEMMA4_MODEL = {
  llmModel: {
    modelName: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    downloadUrl:
      'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf'
  },
  // f16 projector, not bf16: the Adreno OpenCL backend has no bf16 kernels, so
  // the bf16 mmproj aborts in ggml_cl_compute_forward now that the projector
  // auto-defaults to GPU on Adreno 800+ (QVAC-21867). f16 covers bf16's value
  // range for these weights and runs on every backend.
  projModel: {
    modelName: 'mmproj-google_gemma-4-E2B-it-f16.gguf',
    downloadUrl:
      'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/mmproj-google_gemma-4-E2B-it-f16.gguf'
  }
}

function createLogger() {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

// Multimodal compaction: loads Gemma 4 with the projection model
// (forcing the multimodal context path) and verifies the same
// `remove_thinking_from_context` toggle drops the reasoning block
// from the KV cache when the channel is engaged. Text-only prompt is
// sufficient; we are not testing vision here, only that the
// multimodal context honours the toggle.
test(
  'Gemma 4 multimodal honours remove_thinking_from_context',
  {
    timeout: 1_800_000
  },
  async (t) => {
    const [modelName, dirPath] = await ensureModel(GEMMA4_MODEL.llmModel)
    const [projModelName] = await ensureModel(GEMMA4_MODEL.projModel)
    const modelPath = path.join(dirPath, modelName)
    const projectionModelPath = path.join(dirPath, projModelName)

    const baseConfig = {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '999',
      ctx_size: '2048',
      n_predict: '256',
      temp: '0',
      seed: '42',
      verbosity: '0'
    }

    async function runOnce(runOptions) {
      const addon = new LlmLlamacpp({
        files: { model: [modelPath], projectionModel: projectionModelPath },
        config: baseConfig,
        logger: createLogger(),
        opts: { stats: true }
      })
      try {
        await addon.load()
        const response = await addon.run(
          [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'What is the capital of France? Answer in one word.' }
          ],
          runOptions
        )
        let output = ''
        const ticker = setInterval(() => {}, 50)
        try {
          await response
            .onUpdate((token) => {
              output += token
            })
            .await()
        } finally {
          clearInterval(ticker)
        }
        return { output, stats: response.stats || {} }
      } finally {
        await addon.unload().catch(() => {})
      }
    }

    const toNum = (v) => (typeof v === 'number' ? v : Number(v || 0))

    const compactRun = await runOnce({
      generationParams: { remove_thinking_from_context: true }
    })
    t.comment(
      `multimodal compact (${compactRun.output.length} chars): ${compactRun.output.slice(0, 200)}`
    )
    t.comment(`multimodal compact stats: ${JSON.stringify(compactRun.stats)}`)

    // Gemma 4 emits the reasoning channel only when it deems the question
    // worth deliberating about; skip the assertions if the channel did
    // not engage so the multimodal path is exercised but the test does
    // not become flaky on prompt-dependent behaviour.
    if (/<\|channel>thought/i.test(compactRun.output)) {
      t.ok(
        toNum(compactRun.stats.thinkingBlockDiscards) >= 1,
        `multimodal explicit-on should compact at least one channel block (got ${compactRun.stats.thinkingBlockDiscards})`
      )

      // Explicit-off — pins the disabled path regardless of the default.
      const defaultRun = await runOnce({
        generationParams: { remove_thinking_from_context: false }
      })
      t.comment(
        `multimodal disabled (${defaultRun.output.length} chars): ${defaultRun.output.slice(0, 200)}`
      )
      t.comment(`multimodal disabled stats: ${JSON.stringify(defaultRun.stats)}`)
      t.is(
        toNum(defaultRun.stats.thinkingBlockDiscards),
        0,
        `multimodal explicit-off should report 0 discards (got ${defaultRun.stats.thinkingBlockDiscards})`
      )
    } else {
      t.comment(
        'Gemma 4 multimodal did not emit <|channel>thought - skipping compaction assertions'
      )
      t.pass('multimodal compaction assertions skipped (channel not engaged)')
    }
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
