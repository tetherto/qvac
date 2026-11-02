'use strict'

const IdEnc = require('hypercore-id-encoding')

const TIMEOUT_WINDOW_MS = 10 * 60 * 1000
const TIMEOUT_WARNING_THRESHOLD = 3

class SwarmConnectionLogger {
  constructor(logger, { now = Date.now } = {}) {
    this.logger = logger
    this._now = now
    this._timeouts = new Map()
    this._closed = false
  }

  track(conn, peerInfo) {
    const publicKey = conn.remotePublicKey || peerInfo?.publicKey
    const peer = publicKey ? IdEnc.normalize(publicKey) : 'unknown'
    const openedAt = this._now()
    const context = () => ({
      peer,
      direction: conn.isInitiator ? 'outbound' : 'inbound',
      durationMs: this._now() - openedAt,
      bytesRead: conn.rawBytesRead,
      bytesWritten: conn.rawBytesWritten,
      retransmits: conn.rawStream?.retransmits,
      rtoCount: conn.rawStream?.rtoCount
    })

    if (!this._closed) this.logger.debug(context(), 'Swarm connection opened')
    conn.on('error', (err) => {
      if (this._closed) return
      const data = { ...context(), error: err.message, code: err.code }

      if (err.code === 'ETIMEDOUT') {
        this.logger.debug(data, 'Swarm connection error')
        if (publicKey) this._recordTimeout(peer, data)
      } else if (err.code === 'ECONNRESET' || err.message === 'Duplicate connection') {
        this.logger.debug(data, 'Swarm connection error')
      } else {
        this.logger.warn(data, 'Swarm connection error')
      }
    })
    conn.on('close', () => {
      if (!this._closed) this.logger.debug(context(), 'Swarm connection closed')
    })
  }

  _recordTimeout(peer, data) {
    const now = this._now()
    const cutoff = now - TIMEOUT_WINDOW_MS

    // Prune on activity instead of keeping a background timer alive.
    for (const [key, state] of this._timeouts) {
      if (state.times[state.times.length - 1] <= cutoff) this._timeouts.delete(key)
    }

    const state = this._timeouts.get(peer) || { times: [], lastWarningAt: null }
    state.times = state.times.filter((time) => time > cutoff)
    state.times.push(now)
    this._timeouts.set(peer, state)

    if (state.times.length < TIMEOUT_WARNING_THRESHOLD) return
    if (state.lastWarningAt !== null && now - state.lastWarningAt < TIMEOUT_WINDOW_MS) return

    state.lastWarningAt = now
    this.logger.warn(
      { ...data, timeoutCount: state.times.length, windowMs: TIMEOUT_WINDOW_MS },
      'Swarm peer repeatedly timed out'
    )
  }

  close() {
    this._closed = true
    this._timeouts.clear()
  }
}

module.exports = SwarmConnectionLogger
