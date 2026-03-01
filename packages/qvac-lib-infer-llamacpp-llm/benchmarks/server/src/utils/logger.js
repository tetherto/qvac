'use strict'

const process = require('bare-process')

const levels = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR'
}

const safeStringify = (value) => {
  const seen = new WeakSet()
  return JSON.stringify(value, (key, current) => {
    if (typeof current === 'bigint') {
      return current.toString()
    }

    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
        ...current
      }
    }

    if (current && typeof current === 'object') {
      if (seen.has(current)) {
        return '[Circular]'
      }
      seen.add(current)
    }

    return current
  })
}

const formatArg = (arg) => {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.stack || arg.message || String(arg)}`
  if (arg === undefined) return 'undefined'
  if (arg === null) return 'null'

  try {
    return safeStringify(arg)
  } catch {
    return String(arg)
  }
}

const log = (level, ...messages) => {
  const timestamp = new Date().toISOString()
  const message = messages.length > 0 ? messages.map(formatArg).join(' ') : ''
  const logMessage = `[${timestamp}] [${level}] ${message}\n`
  const stream = level === levels.warn || level === levels.error ? process.stderr : process.stdout
  stream.write(logMessage)
}

module.exports = {
  debug: (...args) => log(levels.debug, ...args),
  info: (...args) => log(levels.info, ...args),
  warn: (...args) => log(levels.warn, ...args),
  error: (...args) => log(levels.error, ...args)
}
