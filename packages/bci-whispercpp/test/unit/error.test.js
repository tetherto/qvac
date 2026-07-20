'use strict'

const test = require('brittle')
const { errorMessage } = require('../../lib/error')

test('[errorMessage] Error instance returns its message', (t) => {
  t.is(errorMessage(new Error('boom')), 'boom', 'message is taken from Error.message')
})

test('[errorMessage] subclassed Error instance returns its message', (t) => {
  class CustomError extends Error {}
  t.is(
    errorMessage(new CustomError('custom failure')),
    'custom failure',
    'message is taken from Error subclass'
  )
})

test('[errorMessage] object with string message returns the message', (t) => {
  t.is(
    errorMessage({ message: 'plain object failure' }),
    'plain object failure',
    'message is read from a non-Error object'
  )
})

test('[errorMessage] bare string is returned as-is', (t) => {
  t.is(errorMessage('raw string error'), 'raw string error', 'string passes through')
})

test('[errorMessage] falls back to "unknown error" for other values', (t) => {
  t.is(errorMessage(undefined), 'unknown error', 'undefined falls back')
  t.is(errorMessage(null), 'unknown error', 'null falls back')
  t.is(errorMessage(42), 'unknown error', 'number falls back')
  t.is(errorMessage({}), 'unknown error', 'object without message falls back')
  t.is(errorMessage({ message: 123 }), 'unknown error', 'object with non-string message falls back')
  t.is(errorMessage({ message: '' }), 'unknown error', 'object with empty message falls back')
})
