'use strict'

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, setupParams, cleanupCheckpoints, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')
const proc = require('bare-process')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'
const isWindows = platform === 'win32'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64
const forceCpuDevice = useCpu || noGpu
const skipFinetuning = useCpu || (noGpu && !isWindows)

const TEST_TIMEOUT_MS = 3600_000

const MODEL = {
  id: 'qwen3-0.6b-q8_0',
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

function waitForProgress(handle, minSteps = 2, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    let count = 0
    const timer = setTimeout(() => {
      handle.removeListener('stats', onStats)
      reject(
        new Error(
          `waitForProgress: no progress after ${timeoutMs}ms (received ${count}/${minSteps} steps)`
        )
      )
    }, timeoutMs)
    const onStats = () => {
      if (++count >= minSteps) {
        clearTimeout(timer)
        handle.removeListener('stats', onStats)
        resolve()
      }
    }
    handle.on('stats', onStats)
  })
}

// The cancel/pause promise carries the scheduler's completion guarantee: once
// it resolves, every job it targeted has left the scheduler (slot released),
// so an immediate follow-up run()/finetune() admission must not be refused as
// busy. A pause() that resolves while the finetuned model is still reloading
// breaks that: activeJobs() stays > 0 for the whole (seconds-wide) reload
// window and any follow-up admission in it throws RUN_BUSY.
safeTest(
  'pause() resolves only after the finetune job releases its scheduler slot',
  { timeout: TEST_TIMEOUT_MS, skip: skipFinetuning },
  async (t) => {
    const [modelName, modelDir] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })

    const finetuneConfig = setupParams(modelDir, {
      checkpointSaveSteps: 10,
      datasetSize: isMobile ? 8 : 16,
      testId: 'cancel-slot-release'
    })
    const checkpointDir = finetuneConfig.checkpointSaveDir
    const loggerHandle = attachSpecLogger({ forwardToConsole: true })

    const model = new LlmLlamacpp({
      files: { model: [path.join(modelDir, modelName)] },
      config: {
        gpu_layers: '999',
        ctx_size: '512',
        device: forceCpuDevice ? 'cpu' : 'gpu',
        verbosity: '2'
      },
      logger: console,
      opts: { stats: true }
    })

    try {
      await model.load()

      const finetuneHandle = await model.finetune(finetuneConfig)
      await waitForProgress(finetuneHandle, 2)

      await model.pause()
      // Sampled synchronously at resolution, before the finetune terminal is
      // awaited: this is exactly what a follow-up finetune()/run() admission
      // checks, and the post-pause model reload keeps it > 0 for seconds when
      // the pause promise resolves too early.
      const activeAfterPause = model.addon.activeJobs()

      const pauseResult = await finetuneHandle.await()
      t.comment(`Pause result: ${JSON.stringify(pauseResult)}`)
      if (pauseResult?.status === 'COMPLETED') {
        // The finetune finished before the pause landed; the slot was released
        // by natural completion, so this run cannot exercise the window.
        t.pass('finetune completed before pause landed; window not exercised')
      } else {
        t.is(
          activeAfterPause,
          0,
          `pause() resolved while the finetune job still held its scheduler slot ` +
            `(activeJobs=${activeAfterPause}); an immediate follow-up run()/finetune() ` +
            `would be refused as RUN_BUSY until the post-pause reload finishes`
        )
      }
    } finally {
      loggerHandle.release()
      await model.unload().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    }
  }
)
