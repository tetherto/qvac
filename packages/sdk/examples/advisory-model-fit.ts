/**
 * Advisory llama.cpp fit check (QVAC-22629).
 *
 * Before a completion or embedding load, the SDK runs `@qvac/model-fit` in one
 * disposable Bare child and projects whether the exact configuration it is
 * about to load will fit in device memory.
 *
 * The result is ADVISORY. It never blocks a load. `does-not-fit` is logged and
 * the ordinary load path runs unchanged. Crashes, timeouts, malformed
 * responses, unsupported configurations, and internal errors all resolve to
 * "no evidence" and are equally non-blocking. Nothing consumes the verdict
 * yet — this PR only produces it.
 *
 * The verdict is emitted on the SDK server log stream, not to stdout, so this
 * example subscribes to `loggingStream({ id: SDK_LOG_ID })` and reprints the
 * `[advisory-fit:…]` lines.
 *
 * ---------------------------------------------------------------------------
 * What fits on this machine (Apple M4 Pro, 24 GiB unified memory)
 * ---------------------------------------------------------------------------
 *
 * Measured with `@qvac/model-fit@0.8.0` (the first release carrying the
 * qvac-fabric#214 memory-reporting fix) at the default 1024 MiB margin. The
 * fitter budgets against what the machine can actually keep resident
 * (total − wired − compressor: 17.4 GiB on this machine at idle), not the raw
 * RAM figure.
 *
 *   PROJECTED TO FIT — all layers on GPU
 *     Qwen3.5 0.8B  Q4_K_M   0.5 GiB  @   4k ctx
 *     gpt-oss-20B   Q4_K_M  10.8 GiB  @  32k ctx
 *     gte-large     fp16     0.6 GiB  (embedding, context pinned to 512)
 *
 *   PROJECTED NOT TO FIT — try any of these to see a `does-not-fit` verdict
 *     gpt-oss-20B   Q4_K_M  10.8 GiB  @ 128k ctx with an f32 KV cache ← below
 *     Gemma 4 31B   Q4_K_M  18.3 GiB  @   1k ctx   ← the weights alone do not
 *                                                    fit with gpu_layers: 99
 *
 * gpt-oss-20B at 128k context FITS with the default KV cache and DOES NOT FIT
 * once `cache-type-k`/`cache-type-v` are set to `f32`. Same model, same
 * context, same machine — the verdict tracks the configuration, not the file
 * size.
 *
 * Two boundaries worth understanding when reading verdicts:
 *
 * 1. The verdict answers for a PLACEMENT, not a model. The SDK's schema
 *    default is `gpu_layers: 99` ("everything on the GPU"), so `does-not-fit`
 *    means "not at this placement". Omit `gpu_layers` and the fitter is free
 *    to move layers to the CPU side instead.
 * 2. A `does-not-fit` configuration can still RUN on macOS when the OS
 *    compresses and pages hard enough — and a `fits` configuration right at
 *    the boundary can still fail at first decode under memory pressure.
 *    Prediction cannot separate those cases from a snapshot; the addon-side
 *    probe decode (QVAC-24114) is the runtime check that catches the
 *    remainder. The verdict here is the honest working-set budget, and the
 *    measured failure modes punish over-committing, so treat `does-not-fit`
 *    as "expect degradation or decode failure", not "the load will error".
 */

import {
  completion,
  loadModel,
  unloadModel,
  loggingStream,
  SDK_LOG_ID,
  QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
  GPT_OSS_20B_INST_Q4_K_M
} from '@qvac/sdk'

// The oversized load below is expected to be reported as `does-not-fit` and
// then attempted anyway, because the check is advisory. It really does try to
// allocate ~11 GiB, so it stays opt-in.
const ATTEMPT_OVERSIZED = process.env['QVAC_FIT_DEMO_ATTEMPT_OVERSIZED'] === '1'

// Reprint the worker's advisory verdicts. They arrive on the SDK server log
// stream; everything else on that stream is filtered out to keep this readable.
//
// Called once per phase rather than once for the process: a subscription
// currently stops delivering after any `unloadModel`, so a single one would go
// silent before the second verdict. Resubscribing after the unload works.
function watchVerdicts(): void {
  void (async () => {
    for await (const log of loggingStream({ id: SDK_LOG_ID })) {
      if (log.message.includes('[advisory-fit:')) {
        console.log(`   ⟶ [${log.level.toUpperCase()}] ${log.message}`)
      }
    }
  })().catch(() => {
    // Stream terminated — normal on shutdown.
  })
}

watchVerdicts()

try {
  // 1. A load the fitter projects to fit. The verdict carries the plan it
  //    projected: resolved context, offloaded layers, and GPU device count.
  console.log('▸ Loading Qwen3.5 0.8B @ 4k — expected verdict: projected to fit')
  const smallModelId = await loadModel({
    modelSrc: QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
    modelConfig: { ctx_size: 4096 }
  })
  console.log(`▸ Loaded ${smallModelId}\n`)

  const result = completion({
    modelId: smallModelId,
    history: [{ role: 'user', content: 'Say hello in five words.' }],
    stream: false,
    generationParams: { predict: 48 }
  })
  const final = await result.final
  console.log(`▸ Completion still works normally: ${final.contentText.trim().slice(0, 120)}\n`)

  // Unloaded before the next phase, so the second load is measured on an idle
  // machine. The fit check projects a single model in isolation and has no
  // notion of what is already resident, so leaving this one loaded would change
  // the outcome without changing the verdict.
  await unloadModel({ modelId: smallModelId, clearStorage: false })
  watchVerdicts()

  // 2. A load the fitter projects NOT to fit. The point of this example is that
  //    the SDK reports the verdict and then loads anyway — the check is
  //    evidence, not admission control.
  if (!ATTEMPT_OVERSIZED) {
    console.log('▸ Skipping the oversized gpt-oss-20B load.')
    console.log('▸ Set QVAC_FIT_DEMO_ATTEMPT_OVERSIZED=1 to let it run and watch the')
    console.log('  load proceed past a `does-not-fit` verdict (allocates ~11 GiB).')
  } else {
    console.log('▸ Loading gpt-oss-20B @ 128k with an f32 KV cache')
    console.log('▸ Expected verdict: projected NOT to fit')
    console.log('▸ The load is attempted regardless. That is the fail-open contract:')
    console.log('  the verdict is evidence, not admission control.\n')
    const bigModelId = await loadModel({
      modelSrc: GPT_OSS_20B_INST_Q4_K_M,
      modelConfig: {
        ctx_size: 131072,
        'cache-type-k': 'f32',
        'cache-type-v': 'f32'
      }
    })
    console.log(`▸ Load returned ${bigModelId} — the advisory verdict did not block it`)

    // Loading is not the same as being usable: a model can load and then fail
    // at decode time. Gemma 4 31B does exactly that on this machine. So run a
    // real completion and report throughput rather than trusting the load.
    try {
      const check = completion({
        modelId: bigModelId,
        history: [{ role: 'user', content: 'Name three colours. Answer briefly.' }],
        stream: false,
        generationParams: { predict: 40 }
      })
      const checkFinal = await check.final
      console.log(
        `▸ ...and it actually runs: ${checkFinal.stats?.tokensPerSecond?.toFixed(1) ?? '?'} tok/s ` +
          `— the OS compressed and paged its way past the working-set budget`
      )
    } catch (inferenceError) {
      console.log(
        `▸ ...but it cannot run: ${
          inferenceError instanceof Error ? inferenceError.message : String(inferenceError)
        }`
      )
      console.log('▸ The verdict was right, and `loadModel` succeeding did not mean usable.')
    }

    await unloadModel({ modelId: bigModelId, clearStorage: false })
  }
} catch (error) {
  // A failing load here is the native loader's own error, not the fit check.
  // The check never throws and never converts a verdict into a load failure.
  console.error('▸ Load failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
}

// The log subscription is an open stream and would otherwise keep the process
// alive after the work is done.
process.exit(process.exitCode ?? 0)
