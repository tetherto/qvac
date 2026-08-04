'use strict'

// MoE expert-LoRA finetune coverage across the finetunable mixture-of-experts
// architectures: qwen35moe (Qwen3.6-35B-A3B) and the gemma-4 MoE (26B-A4B, which
// shares the "gemma4" arch tag and is already finetune-allowlisted). The small
// Qwen3.5/3.6 tier is dense; MoE only exists at the larger tiers. Both models are
// opt-in via QVAC_RUN_MOE_FINETUNE and run under the single gated test below.

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const {
  ensureModel,
  setupParams,
  cleanupCheckpoints,
  assertFiniteMetricIfPresent,
  runLoraInference,
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
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64
const forceCpuDevice = useCpu || noGpu

const moeOptIn = !!(proc.env && proc.env.QVAC_RUN_MOE_FINETUNE === 'true')
const skipMoeFinetuning = useCpu || noGpu || isMobile || !moeOptIn

const MOE_GPU_LAYERS = (proc.env && proc.env.QVAC_MOE_GPU_LAYERS) || '24'

const FINETUNE_TIMEOUT_MS = 7200_000

// Opt-in MoE models (~20-27 GB each, gated behind QVAC_RUN_MOE_FINETUNE). Download
// source (url/sha256/bytes) is resolved from models.manifest.json by `name`. These
// models must never be mobile pre-staged — the MoE test is desktop / opt-in only
// and is not scheduled on any mobile shard in test-groups.json:
// prestage-ignore: Qwen_Qwen3.6-35B-A3B-Q4_0.gguf — desktop opt-in only (~20 GB)
// prestage-ignore: gemma-4-26B-A4B-it-Q8_0.gguf — desktop opt-in only (~27 GB)
//
// `loraModules` is per-model: it targets the per-expert ffn_*_exps tensors so the
// expert-LoRA path is exercised (it no-ops on dense models). qwen35moe stores the
// gate/up experts split; the gemma-4 MoE may store them fused (ffn_gate_up_exps) or
// split, so it targets the superset — ffn_down_exps always matches and fabric only
// errors when ZERO targets match.
const QWEN36_MOE = {
  id: 'qwen3.6-35b-a3b-q4_0',
  name: 'Qwen_Qwen3.6-35B-A3B-Q4_0.gguf',
  loraModules: 'ffn_gate_exps,ffn_down_exps'
}

const GEMMA4_MOE = {
  id: 'gemma-4-26b-a4b-q8_0',
  name: 'gemma-4-26B-A4B-it-Q8_0.gguf',
  loraModules: 'ffn_gate_exps,ffn_up_exps,ffn_down_exps,ffn_gate_up_exps'
}

const MOE_MODELS = [QWEN36_MOE, GEMMA4_MOE]

safeTest(
  'MoE expert LoRA finetune (qwen35moe + gemma-4 MoE, opt-in)',
  { timeout: FINETUNE_TIMEOUT_MS, skip: skipMoeFinetuning },
  async (t) => {
    for (const m of MOE_MODELS) {
      const [modelName, modelDir] = await ensureModel({ modelName: m.name })

      const finetuneConfig = setupParams(modelDir, {
        testId: `moe-${m.id}`,
        loraModules: m.loraModules,
        datasetSize: 8,
        checkpointSaveSteps: 0
      })

      const modelPath = path.join(modelDir, modelName)
      const loggerHandle = attachSpecLogger({ forwardToConsole: true })

      const model = new LlmLlamacpp({
        files: { model: [modelPath] },
        config: {
          gpu_layers: MOE_GPU_LAYERS,
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
        await runLoraInference(t, {
          id: m.id,
          modelPath,
          loraAdapterPath,
          gpuLayers: MOE_GPU_LAYERS,
          forceCpuDevice
        })
        t.pass(`[${m.id}] MoE expert LoRA finetune + inference completed`)
      } finally {
        loggerHandle.release()
        await model.unload().catch(() => {})
        cleanupCheckpoints(finetuneConfig.checkpointSaveDir)
      }
    }
  }
)
