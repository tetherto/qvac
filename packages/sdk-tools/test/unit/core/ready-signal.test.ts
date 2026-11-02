import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READY_PREFIX, writeReadySignal } from '@/serve/core/ready-signal'
import { ServeOptionsError, validateServeStartup } from '@/serve/core/startup'

describe('serve ready signal', () => {
  it('writes one prefixed JSON line and closes the descriptor', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qvac-ready-')), 'signal')
    const fd = openSync(path, 'w')
    writeReadySignal(fd, { port: 43210, pid: 99 })
    assert.equal(readFileSync(path, 'utf8'), `${READY_PREFIX}{"port":43210,"pid":99}\n`)
    assert.throws(() => writeReadySignal(fd, { port: 1, pid: 1 }))
  })

  it('refuses stdio and non-integer descriptors', () => {
    for (const readyFd of [0, 1, 2, -1, 3.5, Number.NaN]) {
      assert.throws(() => validateServeStartup([], { port: 0, readyFd }), ServeOptionsError)
    }
    validateServeStartup([], { port: 0, readyFd: 3 })
  })
})
