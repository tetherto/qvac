/**
 * Cross-client conformance runner (JS side, Phase D of the drift plan).
 *
 * Runs the shared corpus in ./cases.json through the JS SDK against a
 * locally-built worker and asserts the same expectations the Python runner
 * (packages/sdk-python/tests/test_conformance.py) checks. One corpus, both
 * clients — so they cannot drift on the covered behaviour.
 *
 * Run from packages/sdk with a built dist:  bun e2e/conformance/run.mjs
 */
import { readFileSync } from 'node:fs'
import * as sdk from '@qvac/sdk'
import {
  cancel,
  completion,
  embed,
  InferenceCancelledError,
  loadModel,
  textToSpeech,
  translate,
  unloadModel
} from '@qvac/sdk'

const { cases } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function assertText(expect, text, id) {
  if (expect.kind === 'contains') {
    if (!text.includes(expect.value)) {
      throw new Error(`${JSON.stringify(text)} does not contain ${JSON.stringify(expect.value)}`)
    }
  } else if (expect.kind === 'nonempty') {
    if (!text.trim()) throw new Error(`expected non-empty output, got ${JSON.stringify(text)}`)
  } else {
    throw new Error(`unexpected text expectation ${expect.kind}`)
  }
}

async function runCase(testCase) {
  const { category, model, modelType, modelConfig, params, expect } = testCase
  const modelSrc = sdk[model]
  if (!modelSrc) throw new Error(`unknown model constant ${model}`)
  const loadOpts = { modelSrc, modelType, ...(modelConfig && { modelConfig }) }

  // Worker-driven tool loop: only the Python client wraps it
  // (`completion_orchestrate`). The JS client runs tool loops client-side, so
  // there is no JS entry point that drives the worker loop -- skip rather than
  // reimplement the loop here (that would test the runner, not the SDK). Skip
  // before loadModel: the case's modelConfig is expressed in the worker's
  // snake_case (`n_ctx`), which the JS client's camelCase modelConfig schema
  // rejects. The Python runner covers this case; see cases.json's description.
  if (category === 'completionOrchestrate') {
    console.log(
      `SKIP ${testCase.id} (completionOrchestrate is worker-driven; JS orchestrates client-side)`
    )
    return
  }

  if (category === 'modelLifecycle') {
    const modelId = await loadModel(loadOpts)
    if (!modelId) throw new Error('load returned no model id')
    await unloadModel({ modelId })
    return
  }

  const modelId = await loadModel(loadOpts)

  if (category === 'completion') {
    const run = completion({
      modelId,
      history: params.history,
      stream: false,
      ...(params.generationParams && { generationParams: params.generationParams })
    })
    assertText(expect, await run.text, testCase.id)
  } else if (category === 'translate') {
    const run = translate({
      modelId,
      text: params.text,
      to: params.to,
      ...(params.from && { from: params.from }),
      modelType,
      stream: false
    })
    assertText(expect, await run.text, testCase.id)
  } else if (category === 'embed') {
    const vec = async (text) => (await embed({ modelId, text })).embedding
    const relatedA = await vec(params.related[0])
    const relatedB = await vec(params.related[1])
    const unrelated = await vec(params.unrelated)
    if (!(cosine(relatedA, relatedB) > cosine(relatedA, unrelated))) {
      throw new Error('related texts should embed closer than unrelated')
    }
  } else if (category === 'cancel') {
    const run = completion({ modelId, history: params.history, stream: true })
    setTimeout(() => void cancel({ requestId: run.requestId }), 250)
    let cancelled = false
    for await (const event of run.events) {
      if (event.type === 'completionDone') cancelled = event.stopReason === 'cancelled'
    }
    try {
      await run.text
    } catch (error) {
      if (error instanceof InferenceCancelledError) cancelled = true
      else throw error
    }
    if (!cancelled) throw new Error('expected the run to report cancellation')
  } else if (category === 'tts') {
    const run = textToSpeech({ modelId, text: params.text, inputType: 'text', stream: false })
    const buffer = await run.buffer
    if (!buffer || buffer.length === 0) throw new Error('text-to-speech produced no audio')
  } else {
    console.log(`SKIP ${testCase.id} (category ${category} not driven by the JS runner)`)
    return
  }
  await unloadModel({ modelId }).catch(() => {})
}

let failed = 0
for (const testCase of cases) {
  try {
    await runCase(testCase)
    console.log(`PASS ${testCase.id}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${testCase.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`\n${cases.length - failed}/${cases.length} conformance cases passed`)
process.exit(failed ? 1 : 0)
