'use strict'

const test = require('brittle')
const retryableModule = require('../../browser/retryable-module.js')

test('browser module initialization retries after a transient failure', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    let attempts = 0
    const expected = { iteration }
    const load = retryableModule(() => {
      attempts++
      if (attempts === 1) return Promise.reject(new Error('transient fetch failure'))
      return expected
    })

    await t.exception.all(() => load(), /transient fetch failure/)
    t.is(await load(), expected)
    t.is(await load(), expected)
    t.is(attempts, 2)
  }
})
