'use strict'

const promClient = require('prom-client')

class QvacMetrics {
  constructor (service, opts = {}) {
    this._service = service
    this._logger = opts.logger || console

    this._rpcRequests = new promClient.Counter({
      name: 'qvac_registry_rpc_requests_total',
      help: 'Total RPC requests by method',
      labelNames: ['method']
    })

    this._rpcErrors = new promClient.Counter({
      name: 'qvac_registry_rpc_errors_total',
      help: 'Total RPC errors by method',
      labelNames: ['method']
    })

    this._registerGauges()
  }

  recordRpcRequest (method) {
    this._rpcRequests.inc({ method })
  }

  recordRpcError (method) {
    this._rpcErrors.inc({ method })
  }

  _registerGauges () {
    const self = this

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_models_total',
      help: 'Total number of models in the registry',
      collect () {
        this.set(self._service.modelCount)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_total_blob_bytes',
      help: 'Total bytes across all model blobs (sum of blobBinding.byteLength across view records)',
      collect () {
        this.set(self._service.totalModelBytes)
      }
    })

    // Derived from totalModelBytes via a background refresh; expose staleness so
    // operators can alert when the refresh stalls.
    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_totals_refreshed_age_seconds',
      help: 'Seconds since qvac_registry_total_blob_bytes and qvac_registry_models_total were last recomputed (-1 if never)',
      collect () {
        const ts = self._service.totalsRefreshedAt
        this.set(ts ? (Date.now() - ts) / 1000 : -1)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_cores_total',
      help: 'Number of blob cores',
      collect () {
        this.set(self._service.blobsCores.size)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_core_peers',
      help: 'Number of connected peers per blob core',
      labelNames: ['core_name'],
      collect () {
        this.reset()
        for (const [name, { core }] of self._service.blobsCores) {
          this.set({ core_name: name }, core.peers.length)
        }
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_core_fully_downloaded',
      help: 'Whether each blob core is fully downloaded (1=yes, 0=no)',
      labelNames: ['core_name'],
      collect () {
        this.reset()
        for (const [name, { core }] of self._service.blobsCores) {
          const full = core.contiguousLength === core.length && core.length > 0 ? 1 : 0
          this.set({ core_name: name }, full)
        }
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_view_core_length',
      help: 'View core length (total blocks)',
      collect () {
        const viewCore = self._service.view?.core
        this.set(viewCore ? viewCore.length : 0)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_view_core_contiguous_length',
      help: 'View core contiguous length (gap = length - contiguous indicates replication lag)',
      collect () {
        const viewCore = self._service.view?.core
        this.set(viewCore ? viewCore.contiguousLength : 0)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_is_indexer',
      help: 'Whether this node is an indexer (1=yes, 0=no)',
      collect () {
        this.set(self._service.base?.isIndexer ? 1 : 0)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blind_peers_connected',
      help: 'Number of configured blind peers with an active connection',
      collect () {
        this.set(self._service.getConnectedBlindPeerKeys().length)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blind_peer_connected',
      help: 'Whether each configured blind peer currently has an active connection (1=yes, 0=no)',
      labelNames: ['peer_key'],
      collect () {
        this.reset()
        for (const peerKey of self._service.getConfiguredBlindPeerKeys()) {
          this.set(
            { peer_key: peerKey },
            self._service.isBlindPeerConnected(peerKey) ? 1 : 0
          )
        }
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_core_byte_length',
      help: 'Byte length of each blob core (only populated on nodes that opened the blob core locally)',
      labelNames: ['core_name'],
      collect () {
        this.reset()
        for (const [name, { core }] of self._service.blobsCores) {
          this.set({ core_name: name }, core.byteLength)
        }
      }
    })
  }
}

module.exports = QvacMetrics
