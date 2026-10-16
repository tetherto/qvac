'use strict'

const test = require('brittle')
const { EventEmitter } = require('events')
const pino = require('pino')
const SwarmConnectionLogger = require('../../lib/swarm-connection-logger')

test('routine disconnects stay quiet while unexpected failures retain diagnostics', (t) => {
  const h = createHarness()
  for (const code of ['ECONNRESET', 'ETIMEDOUT']) {
    const conn = h.connect(1)
    conn.emit('error', Object.assign(new Error('connection failed'), { code }))
    conn.emit('close')
  }
  h.connect(2).emit('error', new Error('Duplicate connection'))
  t.alike(h.entries, [], 'routine connection events produce no default-level output')

  const conn = h.connect(3)
  h.clock.now = 250
  conn.emit('error', Object.assign(new Error('invalid message'), { code: 'INVALID_MESSAGE' }))
  t.is(h.entries.length, 1)
  t.is(h.entries[0].level, 40)
  t.is(h.entries[0].code, 'INVALID_MESSAGE')
  t.is(h.entries[0].durationMs, 250)
  t.is(h.entries[0].direction, 'inbound')
  t.is(h.entries[0].bytesRead, 100)
  t.is(h.entries[0].retransmits, 2)
})

test('repeated timeouts warn per peer and remain throttled across reconnects', (t) => {
  const h = createHarness()
  h.connect(1).emit('error', timeout())
  h.connect(2).emit('error', timeout())
  h.clock.now = 1000
  h.connect(1).emit('error', timeout())
  t.is(h.entries.length, 0, 'another peer does not contribute to the threshold')
  h.clock.now = 2000
  h.connect(1).emit('error', timeout())
  t.is(h.entries.length, 1)
  t.is(h.entries[0].timeoutCount, 3)
  h.clock.now = 3000
  h.connect(1).emit('error', timeout())
  t.is(h.entries.length, 1, 'reconnecting does not reset the warning throttle')

  h.clock.now = 601000
  h.connect(1).emit('error', timeout())
  t.is(h.entries.length, 1)
  h.clock.now = 602000
  h.connect(1).emit('error', timeout())
  t.is(h.entries.length, 2, 'persistent failures can warn again after ten minutes')
  h.logger.close()
  h.connect(1).emit('error', new Error('shutdown'))
  t.is(h.entries.length, 2, 'shutdown does not generate connection warnings')
})

test('timeout history rolls forward and old failures stop contributing', (t) => {
  const h = createHarness()
  h.connect(1).emit('error', timeout())
  h.clock.now = 590000
  h.connect(1).emit('error', timeout())
  h.clock.now = 600001
  h.connect(1).emit('error', timeout())
  t.is(h.entries.length, 0, 'the first timeout has expired')
  h.clock.now = 600002
  h.connect(1).emit('error', timeout())
  t.is(h.entries.length, 1, 'three recent timeouts still count across a window boundary')
  h.clock.now = 1200003
  h.connect(1).emit('error', timeout())
  t.is(h.entries.length, 1, 'an isolated timeout after a quiet window stays quiet')
})

function timeout() {
  return Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' })
}

function createHarness() {
  const entries = []
  const clock = { now: 0 }
  const sink = pino({ level: 'info' }, { write: (line) => entries.push(JSON.parse(line)) })
  const logger = new SwarmConnectionLogger(sink, { now: () => clock.now })
  return {
    entries,
    clock,
    logger,
    connect(peer) {
      const conn = new EventEmitter()
      conn.remotePublicKey = Buffer.alloc(32, peer)
      conn.isInitiator = false
      conn.rawBytesRead = 100
      conn.rawBytesWritten = 200
      conn.rawStream = { retransmits: 2, rtoCount: 1 }
      logger.track(conn)
      return conn
    }
  }
}
