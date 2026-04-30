'use strict'

const test = require('brittle')
const process = require('bare-process')
const QvacLogger = require('../..')
const {
  LOG_LEVELS,
  LEVEL_PRIORITIES,
  DEFAULT_LEVEL,
  ENV_LOG_LEVEL
} = require('../../constants')

function createDummy () {
  const calls = []
  const logger = {}
  for (const m of ['error', 'warn', 'info', 'debug']) {
    logger[m] = (...msgs) => calls.push([m, msgs])
  }
  return { logger, calls }
}

function createWithGetLevel (level) {
  const { logger, calls } = createDummy()
  logger.getLevel = () => level
  return { logger, calls }
}

function createWithLevelProp (level) {
  const { logger, calls } = createDummy()
  logger.level = level
  return { logger, calls }
}

function createWithLevelFn (level) {
  const { logger, calls } = createDummy()
  logger.level = () => level
  return { logger, calls }
}

// ––– Tests –––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

test('no-arg constructor → set log level to OFF', t => {
  const log = new QvacLogger()
  t.is(log.getLevel(), LOG_LEVELS.OFF)
})

test('default level = DEFAULT_LEVEL when a logger is passed and level cannot be inferred', t => {
  const { logger, calls } = createDummy()
  const log = new QvacLogger(logger)
  t.is(log.getLevel(), DEFAULT_LEVEL)
  // expect error/warn/info but no debug (assuming DEFAULT_LEVEL = INFO)
  log.error('e')
  log.warn('w')
  log.info('i')
  log.debug('d')
  t.ok(calls.some(c => c[0] === 'error'))
  t.ok(calls.some(c => c[0] === 'warn'))
  t.ok(calls.some(c => c[0] === 'info'))
  t.ok(calls.every(c => c[0] !== 'debug'))
})

test('inherits level from logger.getLevel()', t => {
  const { logger, calls } = createWithGetLevel(LOG_LEVELS.WARN)
  const log = new QvacLogger(logger)
  t.is(log.getLevel(), LOG_LEVELS.WARN)
  log.error('e')
  log.warn('w')
  log.info('i')
  t.ok(calls.some(c => c[0] === 'error'))
  t.ok(calls.some(c => c[0] === 'warn'))
  t.ok(calls.every(c => c[0] !== 'info'))
})

test('inherits level from logger.level property', t => {
  const { logger, calls } = createWithLevelProp(LOG_LEVELS.ERROR)
  const log = new QvacLogger(logger)
  t.is(log.getLevel(), LOG_LEVELS.ERROR)
  log.error('e')
  log.warn('w')
  t.ok(calls.some(c => c[0] === 'error'))
  t.ok(calls.every(c => c[0] !== 'warn'))
})

test('inherits level from logger.level() function', t => {
  const { logger, calls } = createWithLevelFn(LOG_LEVELS.ERROR)
  const log = new QvacLogger(logger)
  t.is(log.getLevel(), LOG_LEVELS.ERROR)
  log.error('e')
  log.warn('w')
  t.ok(calls.some(c => c[0] === 'error'))
  t.ok(calls.every(c => c[0] !== 'warn'))
})

test('getLevelReflects setLevel', t => {
  const { logger } = createDummy()
  const log = new QvacLogger(logger)
  log.setLevel(LOG_LEVELS.DEBUG)
  t.is(log.getLevel(), LOG_LEVELS.DEBUG)
  log.setLevel(LOG_LEVELS.ERROR)
  t.is(log.getLevel(), LOG_LEVELS.ERROR)
})

test('setLevel invalid → throws', t => {
  const { logger } = createDummy()
  const log = new QvacLogger(logger)
  t.exception(() => log.setLevel('not-a-level'), /Invalid log level: not-a-level/)
})

test('constructor rejects logger missing methods', t => {
  // omit one or more of error/warn/info/debug
  t.exception(() => new QvacLogger({}), /Logger must implement method/)
})

test('per-level gating respects LEVEL_PRIORITIES', t => {
  const { logger, calls } = createDummy()
  const log = new QvacLogger(logger)

  // test each level
  for (const level of Object.values(LOG_LEVELS)) {
    if (level === LOG_LEVELS.OFF) continue

    log.setLevel(level)
    calls.length = 0

    for (const msgLevel of Object.values(LOG_LEVELS)) {
      if (msgLevel === LOG_LEVELS.OFF) continue
      log[msgLevel](`msg-${msgLevel}`)
    }

    for (const msgLevel of Object.values(LOG_LEVELS)) {
      if (msgLevel === LOG_LEVELS.OFF) continue

      const shouldLog = LEVEL_PRIORITIES[msgLevel] <= LEVEL_PRIORITIES[level]
      const found = calls.some(c => c[0] === msgLevel)
      t.is(found, shouldLog, `at level=${level}, ${msgLevel} logged? ${shouldLog}`)
    }
  }
})

test('OFF level disables all logs', t => {
  const { logger, calls } = createDummy()
  const log = new QvacLogger(logger)
  log.setLevel(LOG_LEVELS.OFF)
  log.error('x')
  log.warn('y')
  log.info('z')
  log.debug('w')
  t.is(calls.length, 0)
})

test('reads level from environment variable', t => {
  const existingLogLevel = process.env[ENV_LOG_LEVEL] ?? ''
  process.env.QVAC_LOG_LEVEL = LOG_LEVELS.DEBUG

  const { logger, calls } = createDummy()
  const log = new QvacLogger(logger)
  t.is(log.getLevel(), LOG_LEVELS.DEBUG)
  log.info('info')
  log.debug('debug')
  t.ok(calls.some(c => c[0] === 'info'))
  t.ok(calls.some(c => c[0] === 'debug'))

  // Restore original environment variable
  process.env.QVAC_LOG_LEVEL = existingLogLevel
})

test('environment variable takes precedence over logger level', t => {
  const existingLogLevel = process.env[ENV_LOG_LEVEL] ?? ''
  process.env.QVAC_LOG_LEVEL = LOG_LEVELS.ERROR

  const { logger, calls } = createWithGetLevel(LOG_LEVELS.DEBUG)
  const log = new QvacLogger(logger)
  t.is(log.getLevel(), LOG_LEVELS.ERROR)
  log.info('info')
  log.error('error')
  t.ok(calls.some(c => c[0] === 'error'))
  t.ok(calls.every(c => c[0] !== 'info'))

  // Restore original environment variable
  process.env.QVAC_LOG_LEVEL = existingLogLevel
})
