'use strict'

const test = require('brittle')
const { QvacResponse, createJobHandler } = require('../..')
const { makeAbortable } = require('../mocks/abortable')

function cancelHandler() {
  return Promise.resolve()
}

test('output retention is enabled unless explicitly disabled', async (t) => {
  for (const options of [{}, { retainOutput: undefined }, { retainOutput: true }]) {
    const response = new QvacResponse({ cancelHandler, ...options })
    const first = { text: 'first' }
    const second = { text: 'second' }
    response.updateOutput(first)
    response.updateOutput(second)
    response.ended()

    t.is(response.getLatest(), second, 'latest output is retained')
    const result = await response.await()
    t.alike(result, [first, second], 'completion retains every output')
    t.is(result[0], first, 'output identity is preserved')
    const replay = []
    for await (const output of response.iterate()) replay.push(output)
    t.alike(replay, [first, second], 'late iteration replays every output')
  }
})

test('disabled retention delivers media chunks without saving them', async (t) => {
  const response = new QvacResponse({ cancelHandler, retainOutput: false })
  let updates = 0
  let bytes = 0
  let finished
  response.onUpdate((chunk) => {
    updates++
    bytes += chunk.outputArray.byteLength
  })
  response.onFinish((result) => {
    finished = result
  })

  for (let i = 0; i < 32; i++) {
    response.updateOutput({ outputArray: new Uint8Array(64 * 1024) })
  }

  t.is(updates, 32, 'every chunk was delivered')
  t.is(bytes, 2 * 1024 * 1024, 'all media bytes were delivered')
  t.is(response.output.length, 0, 'no chunk history is retained while running')
  t.ok(response.getLatest() === null, 'no latest chunk is retained')
  response.ended()
  t.is((await response.await()).length, 0, 'completion returns no saved chunks')
  t.is(finished, await response.await(), 'finish and await share the terminal result')
})

test('disabled retention preserves explicit terminal results', async (t) => {
  for (const result of [{ status: 'done' }, null, false, 0]) {
    const response = new QvacResponse({ cancelHandler, retainOutput: false })
    let finished
    response.onFinish((value) => {
      finished = value
    })
    response.updateOutput('intermediate')
    response.ended(result)

    t.is(await response.await(), result, 'await preserves the explicit result')
    t.is(finished, result, 'finish preserves the explicit result')
    t.alike(response.output, [], 'intermediate output was not saved')
  }
})

test('disabled retention rejects iteration without attaching listeners', async (t) => {
  const response = new QvacResponse({ cancelHandler, retainOutput: false })
  response.updateOutput('intermediate')

  for (const ended of [false, true]) {
    if (ended) response.ended()
    const listeners = ['output', 'end', 'error'].map((event) => response.listenerCount(event))
    const iterator = response.iterate()
    await t.exception(
      () => iterator.next(),
      /iterate\(\) requires output retention; use onUpdate\(\) instead/,
      'iteration rejects both during and after a job'
    )
    t.alike(
      ['output', 'end', 'error'].map((event) => response.listenerCount(event)),
      listeners,
      'rejected iteration leaves no listeners'
    )
    await iterator.return()
  }
})

test('job handler forwards disabled retention and clears the completed job', async (t) => {
  const jobs = createJobHandler({ cancel: cancelHandler })
  const response = jobs.start({ retainOutput: false })
  let updates = 0
  response.onUpdate(() => updates++)
  jobs.output('first')
  jobs.output('second')
  jobs.end({ count: 2 })

  t.is(updates, 2, 'every job output was delivered')
  t.alike(await response.await(), [], 'job output was not retained')
  t.alike(response.stats, { count: 2 }, 'statistics are unchanged')
  t.is(jobs.active, null, 'the completed job was cleared')
  jobs.output('late')
  t.is(updates, 2, 'late output is ignored')
})

test('startWith preserves retention settings and explicit job results', async (t) => {
  const jobs = createJobHandler({ cancel: cancelHandler })
  const response = new QvacResponse({ cancelHandler, retainOutput: false })
  const result = { status: 'done' }
  t.is(jobs.startWith(response), response, 'the response is preserved')
  jobs.output('intermediate')
  jobs.end(null, result)

  t.is(await response.await(), result, 'the explicit result is preserved')
  t.alike(response.output, [], 'job output was not retained')
  t.is(jobs.active, null, 'the completed job was cleared')
})

test('disabled retention preserves abort failures and active-job cleanup', async (t) => {
  for (const alreadyAborted of [false, true]) {
    const controller = makeAbortable()
    const reason = new Error('aborted')
    if (alreadyAborted) controller.abort(reason)
    const jobs = createJobHandler({ cancel: cancelHandler })
    const response = jobs.start({ signal: controller.signal, retainOutput: false })
    response.updateOutput('intermediate')
    if (!alreadyAborted) controller.abort(reason)
    response.ended('late result')

    t.is(await response.await().catch((error) => error), reason, 'the abort reason is preserved')
    t.alike(response.output, [], 'aborted jobs retain no output')
    t.is(jobs.active, null, 'the aborted job was cleared')
  }
})

test('replacing an opt-out job preserves the next job default', async (t) => {
  const jobs = createJobHandler({ cancel: cancelHandler })
  const first = jobs.start({ retainOutput: false })
  jobs.output('discarded')
  const second = jobs.start()
  await t.exception(() => first.await(), /Stale job replaced/, 'the stale job fails')
  t.alike(first.output, [], 'the stale job retains no output')
  jobs.output('retained')
  jobs.end()
  t.alike(await second.await(), ['retained'], 'the next job retains output by default')
})

test('disabled retention preserves cancel handling', async (t) => {
  let cancellations = 0
  const jobs = createJobHandler({
    cancel() {
      cancellations++
    }
  })
  const response = jobs.start({ retainOutput: false })
  let events = 0
  response.onCancel(() => events++)
  jobs.output('intermediate')
  await response.cancel()

  t.is(cancellations, 1, 'the cancel handler ran')
  t.is(events, 1, 'the cancellation event was delivered')
  jobs.end()
  await response.cancel()
  t.is(cancellations, 1, 'cancel after completion remains a no-op')
  t.alike(await response.await(), [], 'cancel handling retains no output')
})

test('disabled retention settles before throwing terminal listeners', async (t) => {
  for (const failed of [false, true]) {
    const jobs = createJobHandler({ cancel: cancelHandler })
    const response = jobs.start({ retainOutput: false })
    const reason = new Error('job failed')
    response.prependListener(failed ? 'error' : 'end', () => {
      throw new Error('listener failed')
    })
    jobs.output('intermediate')
    t.exception(
      () => (failed ? response.failed(reason) : response.ended()),
      /listener failed/,
      'listener exceptions still propagate'
    )

    const result = await response.await().catch((error) => error)
    if (failed) t.is(result, reason, 'the job failure is preserved')
    else t.alike(result, [], 'completion returns no saved output')
    t.is(jobs.active, null, 'the settled job was cleared despite the listener')
  }
})

test('default retention supports independent live and lagging iterators', async (t) => {
  const response = new QvacResponse({ cancelHandler })
  const first = response.iterate()
  const second = response.iterate()
  const waiting = first.next()
  response.updateOutput('first')
  t.alike(await waiting, { value: 'first', done: false }, 'the live iterator receives output')
  response.updateOutput('second')
  response.ended()

  t.alike(await second.next(), { value: 'first', done: false }, 'a lagging iterator replays output')
  t.alike(await first.next(), { value: 'second', done: false }, 'the live iterator drains history')
  t.alike(
    await second.next(),
    { value: 'second', done: false },
    'iterators have independent positions'
  )
  t.ok((await first.next()).done, 'the live iterator completes')
  t.ok((await second.next()).done, 'the lagging iterator completes')
  t.alike(await response.await(), ['first', 'second'], 'completion still returns all output')
  t.alike(
    ['output', 'end', 'error'].map((event) => response.listenerCount(event)),
    [0, 0, 0],
    'completed iterators remove their listeners'
  )
})

test('disabled retention delivers ordered events without replay or copies', async (t) => {
  const response = new QvacResponse({ cancelHandler, retainOutput: false })
  response.updateOutput('before subscription')
  const received = []
  const other = []
  let latestDuringUpdate = 'unset'
  response.onUpdate((chunk) => {
    received.push(chunk)
    latestDuringUpdate = response.getLatest()
  })
  response.onUpdate((chunk) => other.push(chunk))
  const chunks = ['text', { outputArray: new Uint8Array(8) }, { image: new Uint8Array(16) }]
  for (const chunk of chunks) response.updateOutput(chunk)
  response.ended()

  t.alike(received, chunks, 'only events after subscription are delivered in order')
  t.alike(other, chunks, 'multiple listeners receive all subscribed events')
  t.is(received[1], chunks[1], 'media output is passed through without copying')
  t.is(other[2], chunks[2], 'listeners receive the same output object')
  t.is(latestDuringUpdate, null, 'callbacks cannot read saved history')
  t.alike(await response.await(), [], 'completion does not replay earlier chunks')
})

test('disabled retention preserves output listener exceptions and settlement', async (t) => {
  const jobs = createJobHandler({ cancel: cancelHandler })
  const response = jobs.start({ retainOutput: false })
  const error = new Error('output listener failed')
  response.once('output', () => {
    throw error
  })

  t.exception(() => jobs.output('first'), error, 'listener exceptions still reach the producer')
  let received
  response.onUpdate((chunk) => {
    received = chunk
  })
  jobs.output('second')
  jobs.end()
  t.is(received, 'second', 'later output remains usable')
  t.alike(await response.await(), [], 'throwing listeners do not create retained output')
  t.is(jobs.active, null, 'the job can still settle normally')
})

test('retention settings remain isolated across repeated completed and failed jobs', async (t) => {
  const jobs = createJobHandler({ cancel: cancelHandler })
  let updates = 0
  let retained = 0
  for (let run = 0; run < 100; run++) {
    const retainOutput = run % 2 === 0
    const response = jobs.start({ retainOutput })
    response.onUpdate(() => updates++)
    for (let chunk = 0; chunk < 8; chunk++) jobs.output(new Uint8Array(1024))
    const failure = new Error('job failed')
    if (run % 3 === 0) jobs.fail(failure)
    else jobs.end()
    const result = await response.await().catch((error) => error)
    if (run % 3 === 0 && result !== failure) t.fail('failure identity changed')
    if (jobs.active !== null) t.fail('settled job remained active')
    if (response.output.length !== (retainOutput ? 8 : 0)) {
      t.fail('retention mode leaked between jobs')
    }
    retained += response.output.length
  }
  t.is(updates, 800, 'all jobs delivered every event')
  t.is(retained, 400, 'only retaining jobs saved their output')
  t.is(jobs.active, null, 'no job remains active')
})
