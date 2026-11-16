import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { assessResult, prepareSource, TARGET } from '../diffusion-kv-diagnostic.mjs'

const source = fs.readFileSync(
  new URL('../../../packages/diffusion-cpp/test/integration/abot-world.test.js', import.meta.url),
  'utf8'
)

test('diagnostic selects only the failing lane while retaining its numerical assertions', () => {
  const prepared = prepareSource(source, 'cuda0')
  assert(prepared.includes(JSON.stringify(TARGET)))
  assert.equal(prepared.split("config: { backend: 'cuda0'").length - 1, 3)
  assert(prepared.includes('error <= 1,'))
  assert(prepared.includes('compare(\n          baseline,'))
  assert(prepared.includes('paramsBackend: lane.paramsBackend'))
  assert.throws(() => prepareSource(source, 'auto'))
  assert.throws(() => prepareSource(source.replace("const test = require('brittle')", ''), 'cuda0'))
})

test('a skip, wrong backend or failed numerical assertion cannot report success', () => {
  const good =
    '# tests = 1/1 pass\n# asserts = 63/63 pass\nruntime=CUDA0, params=CUDA0\nruntime=CUDA0, params=CPU\nstream_layers=true\n'
  assert(assessResult(good, 0, 'cuda0'))
  assert(!assessResult(good, 1, 'cuda0'))
  assert(!assessResult(good, 0, 'vulkan0'))
  assert(!assessResult(good.replace('63/63', '28/63'), 0, 'cuda0'))
  assert(!assessResult(good.replace('63/63', '1/1'), 0, 'cuda0'))
  assert(!assessResult(good.replace('params=CPU', 'params=CUDA0'), 0, 'cuda0'))
})

test('default GPU control preserves the original selection and requires GPU execution', () => {
  const prepared = prepareSource(source, 'gpu')
  assert.equal(prepared.split("config: { backend: 'gpu'").length - 1, 3)
  const log =
    '# tests = 1/1 pass\n# asserts = 63/63 pass\nruntime=CUDA0, params=CUDA0\nruntime=CUDA0, params=CPU\nstream_layers=true\n'
  assert(assessResult(log, 0, 'gpu'))
  assert(assessResult(log.replaceAll('CUDA0', 'Vulkan0'), 0, 'gpu'))
  assert(!assessResult(log.replaceAll('CUDA0', 'CPU'), 0, 'gpu'))
})
