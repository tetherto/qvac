'use strict'

class ReseedTracker {
  constructor (blindPeerKeys, logger = console) {
    if (!Array.isArray(blindPeerKeys) || blindPeerKeys.length === 0) {
      throw new Error('ReseedTracker requires at least one blind peer key')
    }

    this.logger = logger
    this.expectedPeerCount = blindPeerKeys.length
    this._cores = []
    this._pollInterval = null
  }

  trackCore (core) {
    if (!core || !core.discoveryKey) {
      throw new TypeError('trackCore expects an opened Hypercore instance')
    }

    const id = core.discoveryKey.toString('hex')
    const exists = this._cores.some(c => c.id === id)
    if (exists) return

    this._cores.push({
      id,
      core,
      lastRemoteContiguous: 0,
      lastProgressAt: Date.now()
    })
  }

  async waitForComplete ({ progressTimeout = 30000, pollInterval = 2500 } = {}) {
    if (this._cores.length === 0) return

    let checkCount = 0

    return new Promise((resolve, reject) => {
      const check = () => {
        const now = Date.now()
        let allDone = true
        checkCount++

        for (const entry of this._cores) {
          const localLength = entry.core?.length || 0

          // Empty cores are done
          if (localLength === 0) continue

          const peers = entry.core?.replicator?.peers || []
          let fullyDownloadedCount = 0
          let maxRemoteContiguous = 0

          for (const peer of peers) {
            const remoteContig = peer.remoteContiguousLength || 0
            maxRemoteContiguous = Math.max(maxRemoteContiguous, remoteContig)
            if (remoteContig >= localLength) fullyDownloadedCount++
          }

          // Log progress periodically (every 4th check = ~10 seconds)
          if (checkCount % 4 === 1) {
            this.logger.info('ReseedTracker: waiting for replication', {
              core: entry.id.substring(0, 16) + '...',
              localLength,
              connectedPeers: peers.length,
              expectedPeers: this.expectedPeerCount,
              fullyDownloaded: fullyDownloadedCount,
              maxRemoteContiguous,
              progress: localLength > 0 ? Math.round((maxRemoteContiguous / localLength) * 100) + '%' : 'N/A'
            })
          }

          // Check if done
          if (fullyDownloadedCount >= this.expectedPeerCount) {
            this.logger.info('ReseedTracker: core complete', {
              core: entry.id.substring(0, 16) + '...',
              localLength,
              peers: fullyDownloadedCount
            })
            continue
          }

          allDone = false

          // Track progress for timeout
          if (maxRemoteContiguous > entry.lastRemoteContiguous) {
            entry.lastRemoteContiguous = maxRemoteContiguous
            entry.lastProgressAt = now
          }

          // Check stall
          if (now - entry.lastProgressAt > progressTimeout) {
            clearInterval(this._pollInterval)
            this._pollInterval = null

            // Provide detailed error info
            const errorDetails = {
              core: entry.id.substring(0, 16) + '...',
              localLength,
              connectedPeers: peers.length,
              expectedPeers: this.expectedPeerCount,
              maxRemoteContiguous,
              lastProgress: entry.lastRemoteContiguous
            }
            this.logger.error('ReseedTracker: replication stalled', errorDetails)

            let hint = ''
            if (peers.length === 0) {
              hint = ' (no peers connected - is the blind peer running and reachable?)'
            } else if (maxRemoteContiguous === 0) {
              hint = ' (peers connected but no download progress - check blind peer logs)'
            }

            reject(new Error(`ReseedTracker: stalled for ${progressTimeout}ms on core ${entry.id.substring(0, 16)}...${hint}`))
            return
          }
        }

        if (allDone) {
          clearInterval(this._pollInterval)
          this._pollInterval = null
          this.logger.info('ReseedTracker: all cores complete')
          resolve()
        }
      }

      check()
      if (this._pollInterval) return
      this._pollInterval = setInterval(check, pollInterval)
    })
  }

  destroy () {
    if (this._pollInterval) {
      clearInterval(this._pollInterval)
      this._pollInterval = null
    }
    this._cores = []
  }
}

module.exports = ReseedTracker
