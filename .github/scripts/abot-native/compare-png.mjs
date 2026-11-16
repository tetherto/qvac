import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'

const [root, guards, expectedArg] = process.argv.slice(2)
assert(root && guards && expectedArg, 'Expected capture, original PNG guards and frame count')
const original = fs.readFileSync(guards, 'utf8')
const context = {
  Buffer,
  module: { exports: {} },
  require(name) {
    assert.equal(name, 'bare-zlib')
    return zlib
  }
}
vm.runInNewContext(original, context, { filename: guards })
const { pngMeanAbsoluteError } = context.module.exports
const results = []
for (const [baseline, candidate] of [
  ['resident-no-kv', 'stream-no-kv'],
  ['resident-kv', 'stream-kv'],
  ['resident-kv', 'disk-kv']
]) {
  const a = fs
    .readdirSync(path.join(root, baseline))
    .filter((x) => x.endsWith('.png'))
    .sort()
  const b = fs
    .readdirSync(path.join(root, candidate))
    .filter((x) => x.endsWith('.png'))
    .sort()
  assert.equal(a.length, Number(expectedArg), 'Missing native output frames')
  assert.deepEqual(a, b, 'Native frame names differ')
  const errors = a.map((file) => {
    const error = pngMeanAbsoluteError(
      fs.readFileSync(path.join(root, baseline, file)),
      fs.readFileSync(path.join(root, candidate, file))
    )
    assert(Number.isFinite(error), 'Invalid PNG comparison')
    return { file, error }
  })
  results.push({
    baseline,
    candidate,
    errors,
    maxError: Math.max(...errors.map((x) => x.error)),
    passed: errors.every((x) => x.error <= 1)
  })
}
console.log(JSON.stringify(results, null, 2))
if (results.some((x) => !x.passed)) process.exitCode = 1
