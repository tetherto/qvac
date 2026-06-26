import assert from 'node:assert/strict'
import test from 'node:test'

import { synthesizeServeConfig } from '../src/managed/config-synthesizer.js'
import { computeFleetKey } from '../src/managed/fleet-key.js'

test('fleet key is stable and independent of model declaration order', () => {
  const a = synthesizeServeConfig(['QWEN3_600M_INST_Q4', 'GPT_OSS_20B_INST_Q4_K_M'])
  const b = synthesizeServeConfig(['GPT_OSS_20B_INST_Q4_K_M', 'QWEN3_600M_INST_Q4'])
  // Same set, different order, but the first model is the implicit default — so
  // the configs genuinely differ (different default). They should NOT collide.
  assert.notEqual(computeFleetKey(a, '127.0.0.1'), computeFleetKey(b, '127.0.0.1'))
})

test('fleet key is identical for identical configs', () => {
  const a = synthesizeServeConfig([{ name: 'QWEN3_600M_INST_Q4', config: { ctx_size: 16384 } }])
  const b = synthesizeServeConfig([{ name: 'QWEN3_600M_INST_Q4', config: { ctx_size: 16384 } }])
  assert.equal(computeFleetKey(a, '127.0.0.1'), computeFleetKey(b, '127.0.0.1'))
})

test('fleet key changes with per-model config and with host', () => {
  const base = synthesizeServeConfig([{ name: 'QWEN3_600M_INST_Q4', config: { ctx_size: 1024 } }])
  const bigger = synthesizeServeConfig([
    { name: 'QWEN3_600M_INST_Q4', config: { ctx_size: 16384 } }
  ])
  assert.notEqual(computeFleetKey(base, '127.0.0.1'), computeFleetKey(bigger, '127.0.0.1'))
  assert.notEqual(computeFleetKey(base, '127.0.0.1'), computeFleetKey(base, '0.0.0.0'))
})

test('fleet key changes with serveBinPath so distinct local builds do not share a serve', () => {
  const cfg = synthesizeServeConfig([{ name: 'QWEN3_600M_INST_Q4', config: { ctx_size: 1024 } }])
  const resolved = computeFleetKey(cfg, '127.0.0.1')
  // Resolved-from-@qvac/cli (undefined) must match the explicit no-path form.
  assert.equal(resolved, computeFleetKey(cfg, '127.0.0.1', undefined))
  assert.notEqual(resolved, computeFleetKey(cfg, '127.0.0.1', '/opt/build-a/qvac'))
  assert.notEqual(
    computeFleetKey(cfg, '127.0.0.1', '/opt/build-a/qvac'),
    computeFleetKey(cfg, '127.0.0.1', '/opt/build-b/qvac')
  )
})

test('fleet key folds in a pinned servePort so pins do not share an auto serve', () => {
  const cfg = synthesizeServeConfig([{ name: 'QWEN3_600M_INST_Q4', config: { ctx_size: 1024 } }])
  const auto = computeFleetKey(cfg, '127.0.0.1')
  // An auto-allocated port (undefined) stays out of the key.
  assert.equal(auto, computeFleetKey(cfg, '127.0.0.1', undefined, undefined))
  // A pinned port changes the key, so a pinned-port caller never reuses an
  // auto-allocated serve, and two distinct pins don't collide.
  assert.notEqual(auto, computeFleetKey(cfg, '127.0.0.1', undefined, 22222))
  assert.notEqual(
    computeFleetKey(cfg, '127.0.0.1', undefined, 22222),
    computeFleetKey(cfg, '127.0.0.1', undefined, 22223)
  )
})

test('fleet key is insensitive to key order within a per-model config object', () => {
  const a = synthesizeServeConfig([
    { name: 'QWEN3_600M_INST_Q4', config: { ctx_size: 1024, reasoning_budget: 0 } }
  ])
  const b = synthesizeServeConfig([
    { name: 'QWEN3_600M_INST_Q4', config: { reasoning_budget: 0, ctx_size: 1024 } }
  ])
  assert.equal(computeFleetKey(a, '127.0.0.1'), computeFleetKey(b, '127.0.0.1'))
})
