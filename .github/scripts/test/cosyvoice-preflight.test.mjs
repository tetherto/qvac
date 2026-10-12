import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(new URL('../../workflows/prebuilds-nx.yml', import.meta.url), 'utf8')
const desktop = workflow.split('\n  preflight-desktop:')[1]
const cpp = workflow.split('\n  preflight-cpp:')[1].split('\n  preflight-desktop:')[0]
const dispatchGuard = "if: github.event_name == 'workflow_dispatch' && inputs.cosyvoice_preflight"

test('preflight is opt-in and selects only TTS', () => {
  assert.match(workflow, /cosyvoice_preflight:[\s\S]*?default: false/)
  assert.ok(workflow.includes("inputs.cosyvoice_preflight && '[\"tts-ggml\"]' || inputs.packages"))
  assert.ok(cpp.includes(dispatchGuard))
  assert.ok(desktop.includes(dispatchGuard))
  assert.ok(cpp.includes("packages: '[\"tts-ggml\"]'"))
  assert.ok(desktop.includes("packages: '[\"tts-ggml\"]'"))
})

test('desktop tests consume successful prebuilds in the same run at the dispatched revision', () => {
  assert.match(desktop, /needs: prebuild/)
  assert.ok(desktop.includes('ref: ${{ github.sha }}'))
  assert.ok(cpp.includes('ref: ${{ github.sha }}'))
  assert.match(desktop, /uses: \.\/\.github\/workflows\/integration-test-nx\.yml/)
  assert.match(desktop, /run_integration_tests: true/)
  assert.match(desktop, /run_rtf_benchmarks: false/)
  assert.doesNotMatch(desktop, /prebuild_package:|always\(\)|continue-on-error:|publish|integration-mobile/)
})
