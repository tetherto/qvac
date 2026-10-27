import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'

const shutdown = new URL('../../dist/lib/api/shutdown.js', import.meta.url).href

async function fixture(t, mode = 'close') {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { installShutdown } from ${JSON.stringify(shutdown)}
    const mode = ${JSON.stringify(mode)}
    installShutdown(async (signal) => {
      process.send({ closing: true, signal })
      if (mode === 'reject') throw new Error('close failed')
      if (mode === 'hang') await new Promise(() => {})
      process.send({ closed: true })
    })
    process.on('message', (message) => {
      if (message === 'throw') throw new Error('fatal failure')
      if (message === 'reject') Promise.reject(new Error('rejected failure'))
    })
    if (mode === 'natural') process.channel.unref()
    else setInterval(() => {}, 1000)
    process.send({ ready: true })
  `
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  )
  let stderr = ''
  const messages = []
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data
  })
  child.on('message', (message) => messages.push(message))
  const exited = once(child, 'exit')
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  await once(child, 'message')
  return { child, exited, messages, stderr: () => stderr }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`shutdown closes once and exits zero on ${signal}`, async (t) => {
    const run = await fixture(t)
    run.child.kill(signal)
    assert.deepEqual(await run.exited, [0, null])
    assert.deepEqual(
      run.messages.filter((m) => m.closing),
      [{ closing: true, signal }]
    )
    assert.equal(run.messages.filter((m) => m.closed).length, 1)
  })
}

test('normal event-loop exit runs cleanup', async (t) => {
  const run = await fixture(t, 'natural')
  assert.deepEqual(await run.exited, [0, null])
  assert.equal(run.messages.filter((m) => m.closed).length, 1)
})

for (const error of ['throw', 'reject']) {
  test(`fatal ${error} runs cleanup and exits one`, async (t) => {
    const run = await fixture(t)
    run.child.send(error)
    assert.deepEqual(await run.exited, [1, null])
    assert.equal(run.messages.filter((m) => m.closed).length, 1)
    assert.match(run.stderr(), /failure/)
  })
}

test('close failure exits one and reports the error', async (t) => {
  const run = await fixture(t, 'reject')
  run.child.kill('SIGTERM')
  assert.deepEqual(await run.exited, [1, null])
  assert.match(run.stderr(), /close failed/)
})

test('a second signal interrupts stalled cleanup with exit one', async (t) => {
  const run = await fixture(t, 'hang')
  run.child.kill('SIGTERM')
  await once(run.child, 'message')
  run.child.kill('SIGTERM')
  assert.deepEqual(await run.exited, [1, null])
  assert.match(run.stderr(), /second SIGTERM/)
})

test('stalled cleanup retains the ten-second deadline', { timeout: 15000 }, async (t) => {
  const run = await fixture(t, 'hang')
  const started = Date.now()
  run.child.kill('SIGTERM')
  assert.deepEqual(await run.exited, [1, null])
  assert.ok(Date.now() - started >= 9900, 'must allow the full shutdown window')
  assert.match(run.stderr(), /killed by timeout \(10000ms\)/)
})
