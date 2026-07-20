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
import { completion, loadModel, translate, unloadModel } from '@qvac/sdk'

const { cases } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))

function check(expect, text, id) {
  if (expect.kind === 'contains') {
    if (!text.includes(expect.value)) {
      throw new Error(`${JSON.stringify(text)} does not contain ${JSON.stringify(expect.value)}`)
    }
  } else if (expect.kind === 'nonempty') {
    if (!text.trim()) throw new Error(`expected non-empty output, got ${JSON.stringify(text)}`)
  } else {
    throw new Error(`unknown expectation kind ${expect.kind}`)
  }
}

let failed = 0
for (const testCase of cases) {
  const { id, category, model, modelType, modelConfig, params, expect } = testCase
  try {
    const modelSrc = sdk[model]
    if (!modelSrc) throw new Error(`unknown model constant ${model}`)
    const modelId = await loadModel({
      modelSrc,
      modelType,
      ...(modelConfig && { modelConfig })
    })

    let text
    if (category === 'completion') {
      const run = completion({
        modelId,
        history: params.history,
        stream: false,
        ...(params.generationParams && { generationParams: params.generationParams })
      })
      text = await run.text
    } else if (category === 'translate') {
      const run = translate({
        modelId,
        text: params.text,
        to: params.to,
        ...(params.from && { from: params.from }),
        modelType,
        stream: false
      })
      text = await run.text
    } else {
      console.log(`SKIP ${id} (category ${category} not driven by the JS runner)`)
      continue
    }

    check(expect, text, id)
    console.log(`PASS ${id}`)
    await unloadModel({ modelId })
  } catch (error) {
    failed++
    console.error(`FAIL ${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`\n${cases.length - failed}/${cases.length} conformance cases passed`)
process.exit(failed ? 1 : 0)
