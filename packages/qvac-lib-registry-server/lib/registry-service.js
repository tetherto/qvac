'use strict'

const Autobase = require('autobase')
const ReadyResource = require('ready-resource')
const ProtomuxRPC = require('protomux-rpc')
const Hyperblobs = require('hyperblobs')
const BlindPeering = require('blind-peering')
const path = require('path')
const fsPromises = require('fs').promises
const { pipeline } = require('stream/promises')
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const { downloadFileToCacheDir } = require('@huggingface/hub')
const { createWriteStream, createReadStream } = require('fs')
const cenc = require('compact-encoding')
const crypto = require('crypto')
const IdEnc = require('hypercore-id-encoding')

/**
 * Derive a dedicated RPC discovery key from the autobase key.
 * This creates a separate topic that only the server joins,
 * preventing blind peers from receiving RPC connection attempts.
 */
function deriveRpcDiscoveryKey (autobaseKey) {
  return crypto.createHash('sha256')
    .update(autobaseKey)
    .update('qvac-registry-rpc')
    .digest()
}

const schema = require('@qvac/registry-schema')
const { Router, encode: encodeDispatch } = schema.hyperdispatchSpec
const RegistryDatabase = schema.RegistryDatabase
const ReseedTracker = require('./reseed-tracker')
const { QVAC_MAIN_REGISTRY } = schema
const { getFileMetadata } = require('../utils/file-metadata')
const { parseCanonicalSource, resolveS3Bucket } = require('./source-helpers')
const { isGGUFSource, isFirstShard, extractGGUFMetadata } = require('./gguf-helpers')

const DISPATCH_PUT_MODEL = `@${QVAC_MAIN_REGISTRY}/put-model`
const DISPATCH_PUT_LICENSE = `@${QVAC_MAIN_REGISTRY}/put-license`
const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`
const DISPATCH_REMOVE_INDEXER = `@${QVAC_MAIN_REGISTRY}/remove-indexer`
const DISPATCH_DELETE_MODEL = `@${QVAC_MAIN_REGISTRY}/delete-model`

const BLOB_CORE_NAME = 'models'

class RegistryService extends ReadyResource {
  constructor (store, swarm, config, opts = {}) {
    super()

    this.store = store
    this.swarm = swarm
    this.config = config
    this.logger = opts.logger || console

    this.ackInterval = opts.ackInterval ?? 5000
    this.ackThreshold = opts.ackThreshold ?? 0
    this.autobaseBootstrap = opts.autobaseBootstrap || null
    this.blindPeerKeys = Array.isArray(opts.blindPeerKeys) ? opts.blindPeerKeys : []
    this.skipStorageCheck = opts.skipStorageCheck ?? false
    this.clearAfterReseed = opts.clearAfterReseed ?? false
    this.compactionIntervalMs = opts.compactionIntervalMs ?? (60 * 60 * 1000)

    this.view = null
    this.base = null
    this.applyRouter = new Router()
    this._compactionInterval = null

    this.blobsStore = this.store.namespace('blobs')
    this.blobsCores = new Map()
    this._indexerMonitor = null
    this._mirroredCoreIds = new Set()
    this.blindPeering = null
    this.reseedTracker = null

    this._registerApplyHandlers()

    this.base = new Autobase(this.store, this.autobaseBootstrap, {
      open: this._openAutobase.bind(this),
      apply: this._apply.bind(this),
      close: this._closeAutobase.bind(this),
      ackInterval: this.ackInterval,
      ackThreshold: this.ackThreshold
    })

    this.logger.info('RegistryService: initialized')
  }

  _registerApplyHandlers () {
    this.applyRouter.add(DISPATCH_PUT_MODEL, async (model, context) => {
      await context.view.putModel(model)
    })

    this.applyRouter.add(DISPATCH_PUT_LICENSE, async (license, context) => {
      await context.view.putLicense(license)
    })

    this.applyRouter.add(DISPATCH_ADD_INDEXER, async ({ key }, context) => {
      await context.base.addWriter(key, { indexer: true })
    })

    this.applyRouter.add(DISPATCH_REMOVE_INDEXER, async ({ key }, context) => {
      await context.base.removeWriter(key)
    })

    this.applyRouter.add(DISPATCH_DELETE_MODEL, async ({ path, source }, context) => {
      await context.view.deleteModel(path, source)
    })
  }

  _openAutobase (store) {
    const dbCore = store.get('db-view')
    return new RegistryDatabase(dbCore, { extension: false })
  }

  async _closeAutobase (view) {
    await view.close()
  }

  async _apply (nodes, view, base) {
    if (!view.opened) await view.ready()

    for (const node of nodes) {
      await this.applyRouter.dispatch(node.value, { view, base })
    }

    await view.db.flush()
  }

  async _appendOperation (route, payload) {
    return this.base.append(encodeDispatch(route, payload))
  }

  async _open () {
    this.logger.info('RegistryService: opening')

    await this.store.ready()
    await this.base.ready()
    await this.blobsStore.ready()

    this.view = this.base.view
    await this.view.ready()

    this._logAvailableModels().catch(err => {
      this.logger.error({ err }, 'RegistryService: Failed to log available models')
    })

    this.swarm.on('connection', (conn, peerInfo) => {
      const peerKey = peerInfo?.publicKey ? IdEnc.normalize(peerInfo.publicKey) : 'unknown'

      this.logger.info({ peer: peerKey }, 'Swarm connection opened')
      conn.on('close', () => this.logger.info({ peer: peerKey }, 'Swarm connection closed'))

      this._setupRpc(conn)

      // Create a single replication stream for the store
      const replicationStream = this.store.replicate(conn)

      // Attach Autobase to the replication stream (writer cores, system core)
      this.base.replicate(replicationStream)

      // Also attach the view core to ensure read-only clients can sync
      // Without this, the view core is not included in replication
      if (this.view?.core) {
        this.view.core.replicate(replicationStream)
      }
    })

    // Log if there's a significant contiguous gap for troubleshooting
    // Small gaps (1-10 blocks) are normal while waiting for indexer acks
    if (this.view?.core) {
      const viewCore = this.view.core
      const gap = viewCore.length - viewCore.contiguousLength

      if (gap > 20) {
        this.logger.warn({
          length: viewCore.length,
          contiguousLength: viewCore.contiguousLength,
          signedLength: viewCore.signedLength,
          gap
        }, 'View core has large contiguous gap at startup (may indicate offline indexer)')
      }
    }

    this.swarm.join(this.base.discoveryKey, { server: true, client: true })
    this.swarm.join(this.view.discoveryKey, { server: true, client: true })

    // Join dedicated RPC topic - only the server joins this, not blind peers
    this._rpcDiscoveryKey = deriveRpcDiscoveryKey(this.base.key)
    this.swarm.join(this._rpcDiscoveryKey, { server: true, client: false })

    await this.swarm.flush()
    this.logger.info({
      autobaseKey: IdEnc.normalize(this.base.discoveryKey),
      viewKey: IdEnc.normalize(this.view.discoveryKey),
      rpcKey: IdEnc.normalize(this._rpcDiscoveryKey)
    }, 'Swarm joined')

    if (this.base.isIndexer) {
      const linearizerIndexers = (this.base.linearizer?.indexers || [])
        .map(idx => idx.core?.key ? IdEnc.normalize(idx.core.key) : 'unknown')
      const pendingIndexers = (this.base.system?.pendingIndexers || [])
        .map(k => IdEnc.normalize(k))

      this.logger.info({
        isIndexer: this.base.isIndexer,
        localKey: this.base.localWriter ? IdEnc.normalize(this.base.localWriter.core.key) : null,
        systemMembers: this.base.system?.members ?? 0,
        systemLength: this.base.system?.core?.length ?? -1,
        signedLength: this.base.system?.core?.signedLength ?? -1,
        linearizerIndexers,
        pendingIndexers,
        advancing: this.base._advancing !== null,
        writable: this.base.writable,
        viewLength: this.view?.core?.length ?? -1
      }, 'Pre-indexer-management diagnostics')

      await this._removeIndexers()
      await this._addAdditionalIndexers()
    }

    if (!this.skipStorageCheck && this.autobaseBootstrap && this.base.localWriter && !this.base.isIndexer) {
      const memberCount = this.base.system ? this.base.system.members : 0
      const hasExistingData = this.view.core.length > 0

      if (memberCount <= 1 && !hasExistingData) {
        this.logger.error({
          bootstrapKey: IdEnc.normalize(this.autobaseBootstrap)
        }, 'Configuration error: QVAC_AUTOBASE_KEY is set but storage appears fresh or mismatched. Solutions: 1) Remove QVAC_AUTOBASE_KEY from .env for a fresh start, 2) Use the original storage directory that matches this autobase key')
        throw new Error('Storage/bootstrap key mismatch - cannot initialize as indexer')
      }
    }

    this.logger.info({
      isIndexer: this.base.isIndexer,
      localKey: this.base.localWriter ? IdEnc.normalize(this.base.localWriter.core.key) : null
    }, 'RegistryService: indexer status at startup')

    this.base.on('is-indexer', () => {
      this.logger.info('RegistryService: is-indexer event - I have become an indexer')
    })
    this.base.on('is-non-indexer', () => {
      this.logger.warn('RegistryService: is-non-indexer event - I am no longer an indexer')
    })

    if (!this.base.isIndexer) {
      this._monitorIndexerStatus()
    }

    if (this.base.isIndexer && this.view.core.length === 0) {
      await this.base.append(null)
    }

    this.view.core.download({ start: 0, end: -1 })

    if (this.blindPeerKeys.length > 0) {
      await this._setupBlindPeering()
    }

    if (this.compactionIntervalMs > 0) {
      this._startCompactionInterval()
    }

    this.logger.info('RegistryService: swarm joined and flushed')
  }

  async _close () {
    this.logger.info('RegistryService: closing')

    if (this._compactionInterval) {
      clearInterval(this._compactionInterval)
      this._compactionInterval = null
    }

    const viewDiscoveryKey = this.view ? this.view.discoveryKey : null

    if (this.base) {
      this.swarm.leave(this.base.discoveryKey)
      await this.base.close()
    }

    if (viewDiscoveryKey) {
      this.swarm.leave(viewDiscoveryKey)
    }

    if (this._rpcDiscoveryKey) {
      this.swarm.leave(this._rpcDiscoveryKey)
      this._rpcDiscoveryKey = null
    }

    this.view = null

    if (this._indexerMonitor) {
      clearInterval(this._indexerMonitor)
      this._indexerMonitor = null
    }

    if (this.blindPeering) {
      await this.blindPeering.close().catch(err => {
        this.logger.warn({ error: err.message }, 'Failed to close blind peering')
      })
      this.blindPeering = null
    }

    if (this.reseedTracker) {
      this.reseedTracker.destroy()
      this.reseedTracker = null
    }

    for (const { blobs, core } of this.blobsCores.values()) {
      await blobs.close().catch(err => {
        this.logger.warn({ error: err.message }, 'Failed to close blob store')
      })
      await core.close().catch(err => {
        this.logger.warn({ error: err.message }, 'Failed to close blob core')
      })
    }
    this.blobsCores.clear()
    this._mirroredCoreIds.clear()

    this.logger.info('RegistryService: closed')
  }

  _startCompactionInterval () {
    if (this._compactionInterval) return

    this.logger.info({
      intervalMs: this.compactionIntervalMs
    }, 'RegistryService: starting periodic compaction')

    this._compactionInterval = setInterval(() => {
      this.compactStorage().catch(err => {
        this.logger.error({ error: err.message }, 'Periodic compaction failed')
      })
    }, this.compactionIntervalMs)
  }

  async compactStorage () {
    const startTime = Date.now()
    this.logger.info('RegistryService: starting storage compaction')

    try {
      if (this.store?.storage && typeof this.store.storage.compact === 'function') {
        await this.store.storage.compact()
        const duration = Date.now() - startTime
        this.logger.info({
          durationMs: duration
        }, 'RegistryService: storage compaction completed')
      } else {
        this.logger.warn('RegistryService: storage compaction not available')
      }
    } catch (err) {
      this.logger.error({
        error: err.message
      }, 'RegistryService: storage compaction failed')
    }
  }

  async _setupBlindPeering () {
    if (this.blindPeering || this.blindPeerKeys.length === 0) return

    this.logger.info({
      mirrors: this.blindPeerKeys.length
    }, 'RegistryService: initializing blind peer replication')

    this.blindPeering = new BlindPeering(this.swarm, this.store, {
      mirrors: this.blindPeerKeys
    })
    this.reseedTracker = new ReseedTracker(this.blindPeerKeys, this.logger)
    this._mirroredCoreIds.clear()

    await this.blindPeering.addAutobase(this.base)

    // Announce view core so clients can discover blind peers via database discovery key
    await this.blindPeering.addCore(this.view.core, this.view.core.key, { announce: true })

    const models = await this.view.findModelsByPath({}).toArray()
    if (models.length > 0) {
      try {
        const { core } = await this._getOrCreateBlobsCore(BLOB_CORE_NAME)
        await this._mirrorBlobCore(core)
      } catch (err) {
        this.logger.warn({
          error: err.message
        }, 'RegistryService: failed to initialize blob core for blind peers')
      }
    }

    await this._waitForInitialSeeding()
  }

  async reseed (options = {}) {
    if (Array.isArray(options.blindPeerKeys) && options.blindPeerKeys.length > 0) {
      this.blindPeerKeys = options.blindPeerKeys
    }

    if (this.blindPeerKeys.length === 0) {
      throw new Error('Blind peer keys are required to reseed the registry')
    }

    if (!this.opened) await this.ready()

    if (this.blindPeering) {
      await this.blindPeering.close().catch(err => {
        this.logger.warn({
          error: err.message
        }, 'RegistryService: failed to close existing blind peering before reseed')
      })
      this.blindPeering = null
    }

    if (this.reseedTracker) {
      this.reseedTracker.destroy()
      this.reseedTracker = null
    }

    await this._setupBlindPeering()
  }

  async _waitForInitialSeeding () {
    if (!this.reseedTracker) return

    this.logger.info('RegistryService: waiting for blind peers to finish initial sync')
    await this.reseedTracker.waitForComplete()
    this.logger.info('RegistryService: blind peers finished initial sync')
  }

  async _mirrorBlobCore (core) {
    if (!this.blindPeering) return

    const id = core.discoveryKey.toString('hex')
    if (this._mirroredCoreIds.has(id)) return

    try {
      this.logger.debug({
        core: id.substring(0, 16) + '...',
        length: core.length
      }, 'Mirroring blob core to blind peers')

      await this.blindPeering.addCore(core, core.key, { announce: false })
      this._mirroredCoreIds.add(id)

      if (this.reseedTracker) {
        this.reseedTracker.trackCore(core)
      }
    } catch (err) {
      this.logger.warn({
        core: id,
        error: err.message
      }, 'RegistryService: failed to add blob core to blind peers')
      this._mirroredCoreIds.delete(id)
      throw err
    }
  }

  _setupRpc (conn) {
    const remoteKeyHex = this._getRemotePublicKeyHex(conn)
    const remoteKeyZ32 = remoteKeyHex ? IdEnc.normalize(conn.remotePublicKey) : null

    const ensureWriterAccess = () => {
      if (this._isWriterAuthorized(remoteKeyHex)) return

      this.logger.warn({
        remoteKey: remoteKeyZ32 || remoteKeyHex || 'unknown'
      }, 'RPC: unauthorized writer request')

      const err = new Error('Unauthorized writer RPC request')
      err.code = 'ERR_WRITER_UNAUTHORIZED'
      throw err
    }

    const rpc = new ProtomuxRPC(conn, {
      protocol: 'qvac-registry-rpc',
      valueEncoding: cenc.json
    })

    rpc.respond(
      'add-model',
      async (entry) => {
        ensureWriterAccess()

        if (!this.opened) await this.ready()
        await this._ensureIndexer()

        const skipExisting = entry.skipExisting || false
        const modelEntry = { ...entry }
        delete modelEntry.skipExisting

        const result = await this.addModel(modelEntry, { skipExisting })

        this.logger.info({
          path: result.path,
          source: result.source
        }, 'RPC: add-model completed')

        return {
          success: true,
          model: {
            path: result.path,
            source: result.source
          }
        }
      }
    )

    rpc.respond(
      'put-license',
      async (licenseRecord) => {
        ensureWriterAccess()

        if (!this.opened) await this.ready()
        await this._ensureIndexer()
        await this.putLicense(licenseRecord)

        this.logger.info({
          spdxId: licenseRecord.spdxId
        }, 'RPC: put-license completed')

        return {
          success: true,
          message: 'License operation appended'
        }
      }
    )

    rpc.respond(
      'update-model-metadata',
      async (data) => {
        ensureWriterAccess()

        if (!data.path) throw new TypeError('path is required')
        if (!data.source) throw new TypeError('source is required')

        if (!this.opened) await this.ready()
        await this._ensureIndexer()

        const existing = await this.getModelByKey({ path: data.path, source: data.source })
        if (!existing) throw new Error(`Model not found: ${data.path}`)

        // If explicitly undeprecating, clear deprecation fields
        const isUndeprecating = data.deprecated === false

        const updated = {
          ...existing,
          engine: data.engine ?? existing.engine,
          licenseId: data.licenseId ?? existing.licenseId,
          description: data.description ?? existing.description,
          quantization: data.quantization ?? existing.quantization,
          params: data.params ?? existing.params,
          notes: data.notes ?? existing.notes,
          tags: data.tags ?? existing.tags,
          deprecated: data.deprecated !== undefined ? data.deprecated : existing.deprecated,
          deprecatedAt: isUndeprecating ? '' : (data.deprecatedAt ?? existing.deprecatedAt),
          replacedBy: isUndeprecating ? '' : (data.replacedBy ?? existing.replacedBy),
          deprecationReason: isUndeprecating ? '' : (data.deprecationReason ?? existing.deprecationReason)
        }

        await this._appendOperation(DISPATCH_PUT_MODEL, updated)

        const viewLength = this.view?.core?.length ?? 0
        const viewContiguous = this.view?.core?.contiguousLength ?? 0
        const viewSigned = this.view?.core?.signedLength ?? 0
        this.logger.info({ path: data.path, viewLength, viewContiguous, viewSigned }, 'RPC: update-model-metadata completed')

        return {
          success: true,
          model: updated
        }
      }
    )

    rpc.respond(
      'delete-model',
      async (data) => {
        ensureWriterAccess()

        if (!data.path) throw new TypeError('path is required')
        if (!data.source) throw new TypeError('source is required')

        if (!this.opened) await this.ready()
        await this._ensureIndexer()

        const result = await this.deleteModel({ path: data.path, source: data.source })

        this.logger.info({
          path: data.path,
          source: data.source
        }, 'RPC: delete-model completed')

        return result
      }
    )

    // Server identification endpoint - allows RPC clients to verify they connected
    // to the actual server and not a blind peer (which won't have RPC responders)
    rpc.respond('ping', async () => {
      return {
        role: 'registry-server',
        timestamp: Date.now()
      }
    })

    this.logger.debug('RPC: responder setup on connection')
  }

  _getRemotePublicKeyHex (conn) {
    if (!conn || !conn.remotePublicKey) return null
    return conn.remotePublicKey.toString('hex').toLowerCase()
  }

  _isWriterAuthorized (remoteKeyHex) {
    if (!remoteKeyHex) return false
    const keys = this.config.getAllowedWriterKeys()
    return keys.has(remoteKeyHex)
  }

  _validateAddModelRequest (entry) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('model entry must be an object')
    }

    for (const field of ['source', 'engine', 'licenseId']) {
      if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
        throw new TypeError(`${field} is required`)
      }
    }

    const MAX_FIELD_LENGTH = 512
    const MAX_TAG_LENGTH = 128
    const MAX_TAGS = 50

    for (const field of ['description', 'quantization', 'params', 'notes', 'deprecationReason']) {
      if (entry[field] !== undefined && typeof entry[field] === 'string' && entry[field].length > MAX_FIELD_LENGTH) {
        throw new TypeError(`${field} exceeds maximum length of ${MAX_FIELD_LENGTH}`)
      }
    }

    if (entry.tags) {
      if (!Array.isArray(entry.tags)) {
        throw new TypeError('tags must be an array of strings')
      }
      if (entry.tags.length > MAX_TAGS) {
        throw new TypeError(`tags array exceeds maximum of ${MAX_TAGS} items`)
      }
      if (entry.tags.some(tag => typeof tag !== 'string')) {
        throw new TypeError('tags must be an array of strings')
      }
      if (entry.tags.some(tag => tag.length > MAX_TAG_LENGTH)) {
        throw new TypeError(`each tag must be at most ${MAX_TAG_LENGTH} characters`)
      }
    }
  }

  async addModel (modelEntry, opts = {}) {
    this._validateAddModelRequest(modelEntry)

    await this._ensureLicense(modelEntry.licenseId)

    const sourceInfo = parseCanonicalSource(modelEntry.source)

    if (opts.skipExisting) {
      const existing = await this.getModelByKey({
        path: sourceInfo.path,
        source: sourceInfo.protocol
      })
      if (existing) {
        this.logger.info({ path: sourceInfo.path }, 'addModel: skipping existing model')
        return existing
      }
    }

    this.logger.info({
      source: sourceInfo.canonicalUrl,
      path: sourceInfo.path
    }, 'addModel: starting')

    const tempBase = this.config.getTempStorage()
    const pathHash = crypto.createHash('sha256')
      .update(sourceInfo.path)
      .digest('hex')
      .slice(0, 32)
    const outputDir = path.join(tempBase, pathHash)

    await fsPromises.mkdir(outputDir, { recursive: true })
    const localPath = path.join(outputDir, sourceInfo.filename)

    try {
      await this._downloadArtifact(sourceInfo, localPath)
      const metadata = await getFileMetadata(localPath)

      let ggufMetadata = null
      if (isGGUFSource(sourceInfo.canonicalUrl) && isFirstShard(sourceInfo.canonicalUrl)) {
        ggufMetadata = await extractGGUFMetadata(localPath)
      } else if (isGGUFSource(sourceInfo.canonicalUrl) && !isFirstShard(sourceInfo.canonicalUrl)) {
        this.logger.info({
          source: sourceInfo.canonicalUrl
        }, 'Skipping GGUF metadata extraction for non-first shard')
      }

      const { blobs, core } = await this._getOrCreateBlobsCore(BLOB_CORE_NAME)
      const pointer = await this._uploadFileToHyperblobs(blobs, localPath)

      await this._mirrorBlobCore(core)

      const modelData = this._buildModelEntry(modelEntry, sourceInfo, metadata, pointer, core.key, ggufMetadata)

      await this._appendOperation(DISPATCH_PUT_MODEL, modelData)

      if (this.reseedTracker) {
        await this.reseedTracker.waitForComplete()
        this.logger.info({
          core: core.key.toString('hex').substring(0, 16) + '...',
          blocks: core.length
        }, 'Blob core replicated to blind peers')

        if (this.clearAfterReseed && core.length > 0) {
          const blockCount = core.length

          await core.clear(0, blockCount)

          // Force a small delay to let storage update
          await new Promise(resolve => setTimeout(resolve, 100))

          this.logger.info({
            blocks: blockCount
          }, 'Cleared blob blocks after reseed')
        }
      }

      this.logger.info({
        path: modelData.path,
        source: modelData.source
      }, 'addModel: completed')

      return modelData
    } finally {
      await this._cleanupPath(outputDir)
    }
  }

  async _addAdditionalIndexers () {
    const additionalIndexers = this.config.getAdditionalIndexers()
    if (additionalIndexers.length === 0) return

    let added = 0
    let skipped = 0
    const errors = []

    for (const keyZ32 of additionalIndexers) {
      try {
        const key = IdEnc.decode(keyZ32)

        const existingIndexers = this.base.linearizer?.indexers || []
        const alreadyIndexer = existingIndexers.some(idx =>
          idx.core?.key && idx.core.key.equals(key)
        )

        if (alreadyIndexer) {
          skipped++
          continue
        }

        await this._appendOperation(DISPATCH_ADD_INDEXER, { key })
        added++
      } catch (err) {
        errors.push({ key: keyZ32, error: err.message })
        this.logger.error({
          key: keyZ32,
          error: err.message
        }, 'Failed to add writer as indexer')
      }
    }

    if (added > 0 || skipped > 0) {
      this.logger.info({
        total: additionalIndexers.length,
        added,
        skipped,
        errors: errors.length
      }, 'Additional indexers processed')
    }
  }

  async _removeIndexers () {
    const removeKeys = this.config.getRemoveIndexers()
    if (removeKeys.length === 0) return

    let removed = 0
    let skipped = 0
    const errors = []

    for (const keyZ32 of removeKeys) {
      try {
        const key = IdEnc.decode(keyZ32)

        const existingIndexers = this.base.linearizer?.indexers || []
        const alreadyRemoved = !existingIndexers.some(idx =>
          idx.core?.key && idx.core.key.equals(key)
        )

        if (alreadyRemoved) {
          skipped++
          continue
        }

        if (this.base.local?.key && this.base.local.key.equals(key)) {
          this.logger.warn({ key: keyZ32 }, 'Cannot remove self as indexer, skipping')
          skipped++
          continue
        }

        await this._appendOperation(DISPATCH_REMOVE_INDEXER, { key })
        removed++
      } catch (err) {
        errors.push({ key: keyZ32, error: err.message })
        this.logger.error({
          key: keyZ32,
          error: err.message
        }, 'Failed to remove indexer')
      }
    }

    if (removed > 0 || skipped > 0) {
      this.logger.info({
        total: removeKeys.length,
        removed,
        skipped,
        errors: errors.length
      }, 'Remove indexers processed')
    }
  }

  _monitorIndexerStatus () {
    if (this._indexerMonitor) return

    this._indexerMonitor = setInterval(() => {
      if (!this.base) return
      if (this.base.isIndexer) {
        clearInterval(this._indexerMonitor)
        this._indexerMonitor = null
        this.logger.info('RegistryService: I have become an indexer')
      }
    }, 500)
  }

  async _ensureIndexer (timeout = 30000) {
    if (this.base.isIndexer) return

    this.logger.info('Waiting for indexer status...')

    const startTime = Date.now()
    while (!this.base.isIndexer) {
      if (Date.now() - startTime > timeout) {
        throw new Error('Timeout waiting for indexer status')
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    this.logger.info('Indexer status confirmed')
  }

  async _downloadArtifact (sourceInfo, localPath) {
    switch (sourceInfo.protocol) {
      case 'hf':
        await this._downloadFromHuggingFace(sourceInfo.canonicalUrl, localPath)
        return localPath

      case 's3': {
        const resolved = resolveS3Bucket(sourceInfo, this.config.getS3Bucket())
        await this._downloadFromS3(resolved.bucket, resolved.key, localPath)
        return localPath
      }

      default:
        throw new Error(`Unsupported source protocol: ${sourceInfo.protocol}`)
    }
  }

  async _downloadFromHuggingFace (hfUrl, localPath) {
    this.logger.info({ url: hfUrl }, 'Downloading from HuggingFace')

    const hfToken = this.config.getHuggingFaceToken()
    const parsed = this._parseHfDownloadUrl(hfUrl)

    if (!parsed) {
      throw new Error('Invalid HuggingFace URL')
    }

    const cachePath = await downloadFileToCacheDir({
      repo: parsed.repo,
      path: parsed.hfPath,
      revision: parsed.revision,
      accessToken: hfToken
    })

    await this._ensureLocalPath(localPath)
    await fsPromises.copyFile(cachePath, localPath)

    return localPath
  }

  _parseHfDownloadUrl (urlString) {
    const u = new URL(urlString)
    if (u.hostname !== 'huggingface.co') return null

    const parts = u.pathname.split('/').filter(Boolean)
    const isValidPath = (parts[2] === 'resolve' || parts[2] === 'blob') && parts.length >= 5

    if (!isValidPath) {
      throw new Error('HF URL must be /<repo>/resolve/<rev>/<path> or /<repo>/blob/<rev>/<path>')
    }

    const hfPath = parts.slice(4).map(p => decodeURIComponent(p)).join('/')

    return {
      repo: `${parts[0]}/${parts[1]}`,
      revision: parts[3],
      hfPath
    }
  }

  async _downloadFromS3 (bucket, key, localPath) {
    this.logger.info({ bucket, key }, 'Downloading from S3')

    const s3 = await this._createS3Client()
    await this._ensureLocalPath(localPath)

    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }))

    const writeStream = createWriteStream(localPath)
    await pipeline(Body, writeStream)

    return localPath
  }

  async _createS3Client () {
    const credentials = this.config.getAWSCredentials()
    const config = {}

    if (credentials.region) {
      config.region = credentials.region
    }

    if (credentials.accessKeyId && credentials.secretAccessKey) {
      config.credentials = {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey
      }
    }

    return new S3Client(config)
  }

  async _ensureLocalPath (localPath) {
    await fsPromises.mkdir(path.dirname(localPath), { recursive: true })
    try {
      await fsPromises.unlink(localPath)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn({
          localPath,
          error: err.message
        }, 'Failed to unlink existing file')
      }
    }
  }

  async _cleanupPath (targetPath) {
    try {
      await fsPromises.rm(targetPath, { recursive: true, force: true })
      this.logger.debug({ targetPath }, 'Cleaned up temp path')
    } catch (cleanupErr) {
      this.logger.warn({
        targetPath,
        error: cleanupErr.message
      }, 'Failed to clean up temp path')
    }
  }

  async _getOrCreateBlobsCore (label) {
    if (this.blobsCores.has(label)) {
      return this.blobsCores.get(label)
    }

    this.logger.debug({ label }, 'Getting or creating Hyperblobs core')

    const core = this.blobsStore.get({ name: `blobs-${label}`, writable: true })
    await core.ready()

    const blobs = new Hyperblobs(core)
    await blobs.ready()

    const entry = { blobs, core }
    this.blobsCores.set(label, entry)

    this.logger.debug({
      label,
      key: core.key.toString('hex'),
      discoveryKey: core.discoveryKey.toString('hex')
    }, 'Hyperblobs core ready')

    // Caller is responsible for mirroring after data is added
    return entry
  }

  async _uploadFileToHyperblobs (blobs, localPath) {
    const stat = await fsPromises.stat(localPath)
    const writeStream = blobs.createWriteStream()
    const readStream = createReadStream(localPath)

    await pipeline(readStream, writeStream)

    this.logger.debug({
      size: stat.size,
      path: localPath
    }, 'Uploaded file to Hyperblobs')

    return writeStream.id
  }

  _buildModelEntry (request, sourceInfo, metadata, pointer, blobsCoreKey, ggufMetadata = null) {
    const tags = Array.isArray(request.tags) ? request.tags.filter(Boolean) : []

    const entry = {
      path: sourceInfo.path,
      source: sourceInfo.protocol,
      engine: request.engine,
      licenseId: request.licenseId,
      quantization: request.quantization || '',
      params: request.params || '',
      description: request.description || '',
      notes: request.notes || '',
      tags,
      blobBinding: {
        coreKey: blobsCoreKey,
        blockOffset: pointer.blockOffset,
        blockLength: pointer.blockLength,
        byteOffset: pointer.byteOffset,
        byteLength: pointer.byteLength,
        sha256: metadata.checksum
      }
    }

    if (ggufMetadata) {
      entry.ggufMetadata = JSON.stringify(ggufMetadata)
    }

    if (request.deprecated !== undefined) {
      entry.deprecated = request.deprecated
    }
    if (request.deprecatedAt) {
      entry.deprecatedAt = request.deprecatedAt
    }
    if (request.replacedBy) {
      entry.replacedBy = request.replacedBy
    }
    if (request.deprecationReason) {
      entry.deprecationReason = request.deprecationReason
    }

    return entry
  }

  get serverPublicKey () {
    return this.swarm.keyPair.publicKey
  }

  get registryDiscoveryKey () {
    return this.view ? this.view.discoveryKey : null
  }

  get registryCoreKey () {
    return this.view ? this.view.publicKey : null
  }

  async listModels (query = {}) {
    if (!this.view || !this.view.opened) await this.view.ready()
    const cursor = this.view.findModelsByPath(query)
    return cursor.toArray()
  }

  async getModelByKey (filters = {}) {
    const { path: modelPath, source } = filters
    if (!modelPath || typeof modelPath !== 'string') {
      throw new TypeError('path is required to fetch a model')
    }

    if (!this.view || !this.view.opened) await this.view.ready()
    return this.view.getModel(modelPath, source)
  }

  async deleteModel ({ path, source }) {
    if (!path || typeof path !== 'string') {
      throw new TypeError('path is required')
    }
    if (!source || typeof source !== 'string') {
      throw new TypeError('source is required')
    }

    const existing = await this.getModelByKey({ path, source })
    if (!existing) {
      throw new Error(`Model not found: ${path} (source: ${source})`)
    }

    await this._appendOperation(DISPATCH_DELETE_MODEL, { path, source })

    this.logger.info({ path, source }, 'deleteModel: completed')

    return { success: true, path, source }
  }

  async listLicenses (query = {}) {
    if (!this.view || !this.view.opened) await this.view.ready()
    return this.view.findLicenses(query).toArray()
  }

  async getLicenseByKey (filters = {}) {
    const { spdxId } = filters
    if (!spdxId || typeof spdxId !== 'string') {
      throw new TypeError('spdxId is required to fetch a license')
    }

    if (!this.view || !this.view.opened) await this.view.ready()
    return this.view.getLicense(spdxId)
  }

  async putLicense (licenseRecord) {
    if (!licenseRecord || typeof licenseRecord !== 'object') {
      throw new TypeError('license record must be an object')
    }

    const requiredFields = ['spdxId', 'name', 'url', 'text']
    for (const field of requiredFields) {
      if (typeof licenseRecord[field] !== 'string' || licenseRecord[field].trim().length === 0) {
        throw new TypeError(`${field} is required`)
      }
    }

    await this._appendOperation(DISPATCH_PUT_LICENSE, licenseRecord)

    this.logger.info({
      spdxId: licenseRecord.spdxId
    }, 'putLicense: license operation appended')

    return licenseRecord
  }

  async _ensureLicense (licenseId) {
    const existing = await this.getLicenseByKey({ spdxId: licenseId })
    if (existing) return

    if (!/^[A-Za-z0-9._-]+$/.test(licenseId)) {
      throw new TypeError('Invalid licenseId: must contain only alphanumeric, dot, dash, or underscore characters')
    }

    const licensesDir = path.join(__dirname, '..', 'data', 'licenses')
    const licensePath = path.join(licensesDir, licenseId, 'LICENSE.txt')
    const resolved = path.resolve(licensePath)
    if (!resolved.startsWith(path.resolve(licensesDir))) {
      throw new Error('Invalid licenseId: path traversal detected')
    }

    const metaPath = path.join(__dirname, '..', 'data', 'licenses.json')

    try {
      const text = await fsPromises.readFile(licensePath, 'utf8')
      const metaFile = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'))
      const licenseMeta = metaFile.find(l => l.spdxId === licenseId)

      if (!licenseMeta) {
        throw new Error(`License ${licenseId} not found in licenses.json`)
      }

      await this._appendOperation(DISPATCH_PUT_LICENSE, {
        spdxId: licenseId,
        name: licenseMeta.name,
        url: licenseMeta.url,
        text
      })
      this.logger.info({ spdxId: licenseId }, 'Auto-created license')
    } catch (err) {
      this.logger.error({ licenseId, error: err.message }, 'Failed to load license')
      throw new Error(`License ${licenseId} not available: ${err.message}`)
    }
  }

  async _logAvailableModels () {
    if (!this.view) return

    try {
      if (!this.view.opened) await this.view.ready()
      const models = await this.view.findModelsByPath({}).toArray()

      if (models.length === 0) {
        this.logger.info('RegistryService: No models in registry yet')
      } else {
        const modelsToLog = models.length > 5 ? models.slice(-5) : models
        this.logger.info({
          count: models.length,
          showing: modelsToLog.length,
          models: modelsToLog.map(m => `${m.path} [${m.engine}]`)
        }, 'RegistryService: models available')
      }
    } catch (err) {
      this.logger.error({ err }, 'RegistryService: Failed to log models')
    }
  }

  _normalizeKey (key) {
    if (Buffer.isBuffer(key)) {
      if (key.length !== 32) {
        throw new Error('Writer key must be 32 bytes')
      }
      return key
    }

    if (typeof key === 'string') {
      const buf = Buffer.from(key, 'hex')
      if (buf.length !== 32) {
        throw new Error('Writer key must be a 32-byte hex string')
      }
      return buf
    }

    throw new TypeError('Writer key must be a Buffer or hex string')
  }
}

module.exports = RegistryService
