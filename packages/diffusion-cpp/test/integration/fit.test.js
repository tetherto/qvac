'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const { assessFit } = require('../../index.js')
const { ensureModelPath, safeTest } = require('./utils')

const MODEL_NAME = 'stable-diffusion-v2-1-Q8_0.gguf'

const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const skip = isMobile || (proc.env && proc.env.NO_GPU === 'true')

function tempFile(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

test('an unreadable model returns an error outcome', (t) => {
  const fit = assessFit({ files: { model: '/nonexistent/model.gguf' } })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.is(fit.changed, false)
})

test('a file that is not a model is unreadable too', (t) => {
  const fit = assessFit({ files: { model: tempFile(t, 'model.gguf', Buffer.alloc(512, 7)) } })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

// A load refuses a relative path up front; the fit would otherwise hand it to
// the engine and get back an opaque error.
test('a relative path is refused rather than projected', (t) => {
  try {
    assessFit({ files: { model: 'model.gguf' } })
    t.fail('a relative path should not reach the engine')
  } catch (err) {
    t.ok(err instanceof TypeError)
    t.ok(err.message.includes('must be an absolute path'))
  }
})

test('a pinned placement is refused', (t) => {
  const model = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const pinned = assessFit({ files: { model }, config: { device: 'gpu', 'main-gpu': 0 } })
  t.is(pinned.reason, 'unsupported-config', 'a main-gpu pin the engine cannot validate')

  const cpu = assessFit({ files: { model }, config: { device: 'cpu' } })
  t.is(cpu.reason, 'unsupported-config', 'a cpu device the engine plans as a GPU load')
})

test('a workload number the engine cannot represent is refused', (t) => {
  const model = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))
  const cases = [
    ['NaN', { width: NaN }],
    ['infinity', { height: Infinity }],
    ['above int range', { width: 2147483648 }],
    ['fractional', { height: 512.5 }],
    ['zero frames', { videoFrames: 0 }],
    ['negative tile', { vaeTileSizeX: -1 }],
    ['overlap out of range', { vaeTileOverlap: 1.5 }]
  ]

  for (const [name, workload] of cases) {
    const fit = assessFit({ files: { model }, workload })
    t.is(fit.reason, 'unsupported-config', name)
    t.is(fit.status, 'error', `${name} is an outcome, not a throw`)
  }
})

safeTest('a real model projects a verdict', { timeout: 600_000, skip }, async (t) => {
  const model = await ensureModelPath({ modelName: MODEL_NAME })

  const fit = assessFit({ files: { model } })

  t.comment(`status=${fit.status} reason=${fit.reason} changed=${fit.changed}`)
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.is(fit.reason, fit.status, 'a verdict reports itself as its reason')
  t.ok(fit.report.length > 0, 'the engine reported its placement')
})

safeTest('the workload sizes the projection', { timeout: 600_000, skip }, async (t) => {
  const model = await ensureModelPath({ modelName: MODEL_NAME })

  const small = assessFit({ files: { model }, workload: { width: 512, height: 512 } })
  const large = assessFit({ files: { model }, workload: { width: 8192, height: 8192 } })

  t.comment(`small=${small.status} large=${large.status}`)
  if (small.status !== 'fits') {
    t.pass('this runner cannot hold the model at all')
    return
  }
  t.is(large.status, 'does-not-fit', 'a 16x wider decode is not the same projection')
})
