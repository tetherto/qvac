'use strict'

const test = require('brittle')
const QvacLogger = require('@qvac/logging')
const { forwardTransitionLog, LOG_LEVELS } = require('../../lib/log-forward.js')

// The native log callback must invoke the sink method-style — a detached call
// crashes QvacLogger, whose methods delegate to `this._log`. The dispatch lives
// in lib/log-forward.js (not marian.js) so it is loadable without the binding.

function createRecordingLogger(t) {
  const records = []
  const logger = {}
  for (const level of LOG_LEVELS) {
    logger[level] = function (message) {
      // The crux: `this` must be the logger object, not undefined.
      t.is(this, logger, `${level} called method-style (this === logger)`)
      records.push([level, message])
    }
  }
  logger.records = records
  return logger
}

test('forwardTransitionLog dispatches each priority to the matching level', (t) => {
  const logger = createRecordingLogger(t)

  forwardTransitionLog(logger, 0, 'boom')
  forwardTransitionLog(logger, 1, 'careful')
  forwardTransitionLog(logger, 2, 'fyi')
  forwardTransitionLog(logger, 3, 'details')

  t.alike(logger.records, [
    ['error', 'boom'],
    ['warn', 'careful'],
    ['info', 'fyi'],
    ['debug', 'details']
  ])
})

test('forwardTransitionLog falls back to info for out-of-range priorities', (t) => {
  const logger = createRecordingLogger(t)

  forwardTransitionLog(logger, 4, 'too high')
  forwardTransitionLog(logger, 99, 'way too high')
  forwardTransitionLog(logger, -1, 'negative')

  t.alike(logger.records, [
    ['info', 'too high'],
    ['info', 'way too high'],
    ['info', 'negative']
  ])
})

test('forwardTransitionLog ignores sinks missing the target method', (t) => {
  const partial = {
    error(message) {
      partial.seen = message
    }
  }

  t.execution(() => forwardTransitionLog(partial, 2, 'no info method'))
  t.execution(() => forwardTransitionLog({}, 0, 'empty sink'))
  forwardTransitionLog(partial, 0, 'has error method')
  t.is(partial.seen, 'has error method')
})

test('forwardTransitionLog works against a real QvacLogger (this-binding)', (t) => {
  // QvacLogger's level methods call `this._log(...)`, so forwarding must not
  // detach them from the instance.
  const sink = []
  const inner = {
    error: (...m) => sink.push(['error', ...m]),
    warn: (...m) => sink.push(['warn', ...m]),
    info: (...m) => sink.push(['info', ...m]),
    debug: (...m) => sink.push(['debug', ...m])
  }

  const logger = new QvacLogger(inner)
  logger.setLevel('debug')

  t.execution(() => forwardTransitionLog(logger, 0, 'native error'))
  t.execution(() => forwardTransitionLog(logger, 1, 'native warn'))
  t.execution(() => forwardTransitionLog(logger, 2, 'native info'))
  t.execution(() => forwardTransitionLog(logger, 3, 'native debug'))
  t.execution(() => forwardTransitionLog(logger, 42, 'native fallback'))

  t.alike(sink, [
    ['error', 'native error'],
    ['warn', 'native warn'],
    ['info', 'native info'],
    ['debug', 'native debug'],
    ['info', 'native fallback']
  ])
})

test('a detached call would crash QvacLogger — proves the guard is meaningful', (t) => {
  const inner = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {}
  }
  const logger = new QvacLogger(inner)

  // Plain try/catch rather than t.exception: brittle routes t.exception through
  // a promise, which surfaces this synchronous throw as an unhandled rejection.
  const detached = logger.info
  let caught = null
  try {
    detached('boom')
  } catch (err) {
    caught = err
  }
  t.ok(caught instanceof TypeError, 'detached call throws TypeError')
  t.ok(/_log/.test(caught.message), 'crash is the `this._log` dereference')
})
