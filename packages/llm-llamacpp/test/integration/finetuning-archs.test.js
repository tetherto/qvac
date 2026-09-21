'use strict'

// Small LoRA finetune smoke test for the newer DENSE architectures whose training
// relies on the fork's added backward ops:
//   - GATED_DELTA_NET_BACK
//   - SSM_CONV_BACK
// LoRA targets the dense FFN (ffn_gate + ffn_down) so gradients flow back through the
// gated-delta-net / attention mixers in every layer.

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const {
  ensureModel,
  setupParams,
  cleanupCheckpoints,
  assertFiniteMetricIfPresent,
  runLoraInference,
  waitForProgress,
  verifyPauseCheckpoint,
  handleEarlyCompletion,
  safeTest
} = require('./utils')
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

const FINETUNE_TIMEOUT_MS = 3600_000

// Download source (url/sha256/bytes) is resolved from models.manifest.json by
// `name` at run time; the inline `url` is informational only.
const QWEN35_MODEL = {
  id: 'qwen3.5-0.8b-q4_0',
  name: 'Qwen3.5-0.8B-Q4_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q4_0.gguf'
}

// prestage-ignore: google_gemma-4-E2B-it-Q4_0.gguf — desktop-only (~3.38 GB); the
// mobile shard finetunes Qwen3.5-0.8B only, so it must never be pre-staged.
const GEMMA4_MODEL = {
  id: 'gemma-4-e2b-q4_0',
  name: 'google_gemma-4-E2B-it-Q4_0.gguf'
}

// Desktop finetunes both the small Qwen3.5-0.8B and Gemma-4 E2B: the Q4_0 build is
// only ~3.38 GB, well within the desktop CI runners, so Gemma-4 finetuning gets
// routine coverage rather than being gated behind an opt-in flag. Mobile always
// runs Qwen3.5 only (Gemma-4 is too heavy for the shared mobile shard, and
// Qwen3.5-0.8B is the single model prestaged for it).
const DESKTOP_MODELS = [QWEN35_MODEL, GEMMA4_MODEL]
const FINETUNE_MODELS = isMobile ? [QWEN35_MODEL] : DESKTOP_MODELS

// Dense FFN gate + down; gradients flow through the gated-delta-net / attn mixers.
const LORA_MODULES = 'ffn_gate,ffn_down'

safeTest(
  'small LoRA finetune covers gated-delta-net + dense gemma4 archs',
  { timeout: FINETUNE_TIMEOUT_MS, skip: skipFinetuning },
  async (t) => {
    for (const m of FINETUNE_MODELS) {
      const [modelName, modelDir] = await ensureModel({ modelName: m.name })

      const finetuneConfig = setupParams(modelDir, {
        testId: `archs-${m.id}`,
        loraModules: LORA_MODULES,
        datasetSize: isMobile ? 8 : 16,
        checkpointSaveSteps: 0
      })

      const modelPath = path.join(modelDir, modelName)
      const loggerHandle = attachSpecLogger({ forwardToConsole: true })

      const model = new LlmLlamacpp({
        files: { model: [modelPath] },
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

        const handle = await model.finetune(finetuneConfig)
        let progressCount = 0
        handle.on('stats', (stats) => {
          progressCount++
          t.ok(
            !isNaN(stats.loss),
            `[${m.id}] progress loss must not be NaN (step ${stats.global_steps})`
          )
          t.ok(
            !isNaN(stats.accuracy),
            `[${m.id}] progress accuracy must not be NaN (step ${stats.global_steps})`
          )
          t.comment(
            `[${m.id}] step=${stats.global_steps} loss=${stats.loss?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}%`
          )
        })

        const result = await handle.await()
        t.ok(result, `[${m.id}] finetune must return a result`)
        t.ok(progressCount > 0, `[${m.id}] must receive at least one progress stats event`)
        t.is(
          result.status,
          'COMPLETED',
          `[${m.id}] finetune should COMPLETE (got ${result.status})`
        )
        t.comment(`[${m.id}] finetune result: ${JSON.stringify(result)}`)

        const stats = result.stats
        t.ok(stats, `[${m.id}] terminal result must include stats`)
        t.ok(
          !isNaN(stats.train_loss) && stats.train_loss > 0,
          `[${m.id}] train_loss must be positive finite (got ${stats.train_loss})`
        )
        assertFiniteMetricIfPresent(t, stats, 'train_loss', m.id)
        assertFiniteMetricIfPresent(t, stats, 'train_loss_uncertainty', m.id)
        assertFiniteMetricIfPresent(t, stats, 'val_loss', m.id)
        assertFiniteMetricIfPresent(t, stats, 'train_accuracy', m.id)
        assertFiniteMetricIfPresent(t, stats, 'val_accuracy', m.id)

        await model.unload().catch(() => {})

        const loraAdapterPath = path.join(
          finetuneConfig.outputParametersDir,
          'trained-lora-adapter.gguf'
        )
        await runLoraInference(t, { id: m.id, modelPath, loraAdapterPath, forceCpuDevice })
        t.pass(`[${m.id}] small LoRA finetune + inference completed`)
      } finally {
        loggerHandle.release()
        await model.unload().catch(() => {})
        cleanupCheckpoints(finetuneConfig.checkpointSaveDir)
      }
    }
  }
)

// Checkpoint save/resume coverage for a NEW dense arch. Previously only the
// legacy arch (finetuning-pause-resume.test.js) exercised the addon resume path
// (the `resumeBatch` math in LlamaFinetuningHelpers); qwen35/gemma4 had none.
// Qwen3.5-0.8B is used: smallest new arch, still crosses a pause→resume boundary.
// Desktop-only (`|| isMobile`): this adds a full extra finetune+resume cycle to
// the shared mobile finetuningArchs/funcShardF shard, which would tighten its
// 20/30-min per-test ceiling — and mobile already has pause/resume coverage via
// the legacy-arch finetuning-pause-resume.test.js. Resume coverage for the new
// arch is what matters, and desktop provides it.
safeTest(
  'LoRA finetune pause + resume (qwen35 dense)',
  { timeout: FINETUNE_TIMEOUT_MS, skip: skipFinetuning || isMobile },
  async (t) => {
    const m = QWEN35_MODEL
    const [modelName, modelDir] = await ensureModel({ modelName: m.name })

    const finetuneConfig = setupParams(modelDir, {
      testId: `archs-resume-${m.id}`,
      loraModules: LORA_MODULES,
      datasetSize: isMobile ? 8 : 16,
      checkpointSaveSteps: 10
    })
    const checkpointDir = finetuneConfig.checkpointSaveDir

    const modelPath = path.join(modelDir, modelName)
    const loggerHandle = attachSpecLogger({ forwardToConsole: true })

    const model = new LlmLlamacpp({
      files: { model: [modelPath] },
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

      const handle = await model.finetune(finetuneConfig)
      let progressCount = 0
      handle.on('stats', (stats) => {
        progressCount++
        t.ok(
          !isNaN(stats.loss),
          `[${m.id}] progress loss must not be NaN (step ${stats.global_steps})`
        )
      })
      await waitForProgress(handle, 2)

      await model.pause()
      const pauseResult = await handle.await()

      // Tiny datasets can finish before the pause takes effect — that's a valid
      // path (no resume boundary to cross), accept it and stop.
      if (pauseResult?.status === 'COMPLETED') {
        await handleEarlyCompletion(
          t,
          handle,
          checkpointDir,
          `[${m.id}] finetune completed before pause`
        )
        t.pass(`[${m.id}] finetune completed early (no resume needed)`)
        return
      }

      verifyPauseCheckpoint(t, checkpointDir)

      const resumeHandle = await model.finetune(finetuneConfig)
      resumeHandle.on('stats', (stats) => {
        progressCount++
        t.ok(
          !isNaN(stats.loss),
          `[${m.id}] resume progress loss must not be NaN (step ${stats.global_steps})`
        )
      })
      const result = await resumeHandle.await()

      t.ok(result, `[${m.id}] resume must return a result`)
      t.ok(progressCount > 0, `[${m.id}] must receive at least one progress stats event`)
      t.is(
        result.status,
        'COMPLETED',
        `[${m.id}] resumed finetune should COMPLETE (got ${result.status})`
      )
      // Same dataset/batching as finetuning-pause-resume.test.js, so the total
      // step count must match — proving no batch was skipped or repeated across
      // the resume boundary.
      const expectedGlobalSteps = isMobile ? 6 : 12
      t.is(
        result.stats?.global_steps,
        expectedGlobalSteps,
        `[${m.id}] global_steps should be ${expectedGlobalSteps} across the resume boundary, got ${result.stats?.global_steps}`
      )
      assertFiniteMetricIfPresent(t, result.stats, 'train_loss', m.id)
      assertFiniteMetricIfPresent(t, result.stats, 'val_loss', m.id)
      t.pass(`[${m.id}] pause + resume completed`)
    } finally {
      loggerHandle.release()
      await model.unload().catch(() => {})
      cleanupCheckpoints(finetuneConfig.checkpointSaveDir)
    }
  }
)
