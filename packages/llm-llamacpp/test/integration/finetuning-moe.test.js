'use strict'

// MoE expert-LoRA finetune coverage. This is the ONLY genuinely mixture-of-experts
// model in a finetunable arch (qwen35moe / Qwen3.6): the small Qwen3.5/3.6 tier is
// dense, and MoE only exists at 35B-A3B and up.

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const {
  ensureModel,
  setupParams,
  cleanupCheckpoints,
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

const MOE_MODEL = {
  id: 'qwen3.6-35b-a3b-q4_0',
  name: 'Qwen_Qwen3.6-35B-A3B-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Qwen_Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen_Qwen3.6-35B-A3B-Q4_0.gguf'
}

// MoE expert gate + down projections — these match the per-expert ffn_*_exps tensors,
// so the expert-LoRA path is exercised (it no-ops on dense models).
const LORA_MODULES = 'ffn_gate_exps,ffn_down_exps'

function assertFiniteIfPresent (t, stats, key, id) {
  const v = stats?.[key]
  if (v == null || (typeof v === 'number' && isNaN(v))) return
  t.is(typeof v, 'number', `[${id}] ${key} should be a number when present`)
  t.ok(Number.isFinite(v), `[${id}] ${key} should be finite (not Inf), got: ${v}`)
}

async function runLoraInference (t, id, modelPath, loraAdapterPath) {
  t.comment(`[${id}] Running inference with LoRA adapter: ${loraAdapterPath}`)
  const inferModel = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: {
      gpu_layers: MOE_GPU_LAYERS,
      ctx_size: '512',
      device: forceCpuDevice ? 'cpu' : 'gpu',
      predict: '32',
      lora: loraAdapterPath
    },
    logger: console,
    opts: { stats: true }
  })
  try {
    await inferModel.load()
    const response = await inferModel.run([{ role: 'user', content: 'Hello' }])
    let generated = ''
    await response.onUpdate(token => { generated += token }).await()
    t.ok(generated.length > 0, `[${id}] LoRA inference should produce output`)
    t.comment(`[${id}] LoRA inference output (${generated.length} chars): ${generated.slice(0, 100)}`)
  } finally {
    await inferModel.unload().catch(() => {})
  }
}

safeTest('MoE expert LoRA finetune (qwen35moe, opt-in)', { timeout: FINETUNE_TIMEOUT_MS, skip: skipMoeFinetuning }, async t => {
  const m = MOE_MODEL
  const [modelName, modelDir] = await ensureModel({ modelName: m.name, downloadUrl: m.url })

  const finetuneConfig = setupParams(modelDir, {
    testId: `moe-${m.id}`,
    loraModules: LORA_MODULES,
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
    handle.on('stats', stats => {
      progressCount++
      t.ok(!isNaN(stats.loss), `[${m.id}] progress loss must not be NaN (step ${stats.global_steps})`)
      t.ok(!isNaN(stats.accuracy), `[${m.id}] progress accuracy must not be NaN (step ${stats.global_steps})`)
      t.comment(`[${m.id}] step=${stats.global_steps} loss=${stats.loss?.toFixed(4)} acc=${(stats.accuracy * 100)?.toFixed(1)}%`)
    })

    const result = await handle.await()
    t.ok(result, `[${m.id}] finetune must return a result`)
    t.ok(progressCount > 0, `[${m.id}] must receive at least one progress stats event`)
    t.is(result.status, 'COMPLETED', `[${m.id}] finetune should COMPLETE (got ${result.status})`)
    t.comment(`[${m.id}] finetune result: ${JSON.stringify(result)}`)

    const stats = result.stats
    t.ok(stats, `[${m.id}] terminal result must include stats`)
    t.ok(!isNaN(stats.train_loss) && stats.train_loss > 0, `[${m.id}] train_loss must be positive finite (got ${stats.train_loss})`)
    assertFiniteIfPresent(t, stats, 'train_loss', m.id)
    assertFiniteIfPresent(t, stats, 'train_loss_uncertainty', m.id)
    assertFiniteIfPresent(t, stats, 'val_loss', m.id)
    assertFiniteIfPresent(t, stats, 'train_accuracy', m.id)
    assertFiniteIfPresent(t, stats, 'val_accuracy', m.id)

    await model.unload().catch(() => {})

    const loraAdapterPath = path.join(finetuneConfig.outputParametersDir, 'trained-lora-adapter.gguf')
    await runLoraInference(t, m.id, modelPath, loraAdapterPath)
    t.pass(`[${m.id}] MoE expert LoRA finetune + inference completed`)
  } finally {
    loggerHandle.release()
    await model.unload().catch(() => {})
    cleanupCheckpoints(finetuneConfig.checkpointSaveDir)
  }
})
