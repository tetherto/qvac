/**
 * Advisory model fit check.
 *
 * Before a load, the SDK runs the fitter belonging to the engine that would
 * run it and projects whether the exact configuration it is about to load will
 * fit in device memory. Desktop runs it in a disposable Bare child; mobile,
 * which cannot spawn one, runs it in process.
 *
 * The result is ADVISORY. It never blocks a load. `does-not-fit` is logged and
 * the ordinary load path runs unchanged. Crashes, timeouts, malformed
 * responses, unsupported configurations, and internal errors all resolve to
 * "no evidence" and are equally non-blocking. No verdict changes the load;
 * `getLoadedModelInfo` returns it as `fitProbe`.
 *
 * The verdict is emitted on the SDK server log stream, not to stdout, so this
 * example subscribes to `loggingStream({ id: SDK_LOG_ID })` and reprints the
 * `[advisory-fit:…]` lines.
 *
 * The fitter budgets against what the machine can keep resident, not the raw
 * RAM figure, at a default 1024 MiB margin. The verdict tracks the
 * configuration rather than the file size: one model at one context can fit
 * with the default KV cache and not fit once `cache-type-k`/`cache-type-v`
 * are set to `f32`.
 *
 * Two boundaries worth understanding when reading verdicts:
 *
 * 1. The verdict answers for a PLACEMENT, not a model. With `gpu_layers`
 *    unset, the fitter may move layers to the CPU side; setting it pins the
 *    layer count, and `does-not-fit` then means "not at this placement".
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
        console.log(`▸ [${log.level.toUpperCase()}] ${log.message}`)
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

  // Unloaded before the next phase, so the second verdict is measured on an
  // idle machine and stays comparable to the fixture tables above. Leaving it
  // loaded would shift the verdict: the check reserves resident weight bytes
  // through the fit margin, and the fitter also sees system-wide wired memory.
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
  console.error('✖', error instanceof Error ? error.message : error)
  process.exitCode = 1
}

// The log subscription is an open stream and would otherwise keep the process
// alive after the work is done.
process.exit(process.exitCode ?? 0)
