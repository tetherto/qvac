'use strict'

const { QvacErrorRegistryClient, ERR_CODES } = require('../utils/error')
const { withRetry } = require('../utils/retry')
const RegistryConfig = require('./config')
const { RegistryDatabase } = require('@qvac/registry-schema')
const ReadyResource = require('ready-resource')
const Logger = require('./logger')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperblobs = require('hyperblobs')
const IdEnc = require('hypercore-id-encoding')
const path = require('#path')
const fs = require('#fs')

const DEFAULT_DOWNLOAD_MAX_RETRIES = 3
const RETRIABLE_DOWNLOAD_CODES = ['REQUEST_TIMEOUT']
const INFLIGHT_DRAIN_TIMEOUT_MS = 5000
const INFLIGHT_DRAIN_POLL_MS = 10

// While the app is backgrounded the swarm is suspended; a retry must wait for
// resume rather than burn its (small) retry budget timing out against a dead
// swarm. Bounded so a never-resumed runtime still fails instead of hanging.
const RESUME_WAIT_MAX_MS = 5 * 60 * 1000
const RESUME_WAIT_POLL_MS = 200

class QVACRegistryClient extends ReadyResource {
  constructor(opts = {}) {
    super()

    this.logger = new Logger(opts.logger)
    this.registryConfig = new RegistryConfig({ logger: this.logger })

    this.db = null
    this.hyperswarm = null
    this._connectionHandler = null
    this._metadataReady = null
    this._pendingReleases = new Map()

    this.storage = this.registryConfig.getRegistryStorage(opts.storage)
    this.registryCoreKey = this.registryConfig.getRegistryCoreKey(opts.registryCoreKey)
    this.corestore = new Corestore(this.storage, opts.corestoreOpts || {})

    this.logger.debug('Initializing QVAC Registry Client', {
      mode: 'read',
      registryCoreKey: opts.registryCoreKey ? '***' : 'not provided'
    })

    this.ready()
  }

  async _open() {
    this.logger.debug('_open called')

    this.logger.debug('Opening corestore')
    await this.corestore.ready()

    this.logger.debug('Creating Hyperswarm for open')
    this.hyperswarm = new Hyperswarm()

    this._connectionHandler = (conn, peerInfo) => {
      this.logger.debug('Client peer connected', { peer: IdEnc.normalize(peerInfo.publicKey) })
      this.corestore.replicate(conn)
    }
    this.hyperswarm.on('connection', this._connectionHandler)

    this._metadataReady = this._connectMetadataCore()
    await this._metadataReady
  }

  async _connectMetadataCore() {
    if (!this.registryCoreKey) {
      this.logger.error('Missing registry core key for read mode')
      throw new QvacErrorRegistryClient({
        code: ERR_CODES.FAILED_TO_CONNECT,
        adds: 'Missing registry core key. Set QVAC_REGISTRY_CORE_KEY environment variable.'
      })
    }

    const viewKey = IdEnc.decode(this.registryCoreKey)
    const viewCore = this.corestore.get({ key: viewKey })
    await viewCore.ready()

    this.logger.debug('Joining hyperswarm for registry view', {
      viewKey: IdEnc.normalize(viewCore.key),
      discoveryKey: IdEnc.normalize(viewCore.discoveryKey)
    })

    const foundPeers = viewCore.findingPeers()
    this.hyperswarm.join(viewCore.discoveryKey, { client: true, server: false })
    this.hyperswarm.flush().then(() => foundPeers())

    this.logger.debug('Waiting for view core sync')
    await viewCore.update()

    this.logger.debug('Creating RegistryDatabase from view core')
    this.db = new RegistryDatabase(viewCore, { extension: false })
    await this.db.ready()

    this.logger.debug('QVACRegistryClient metadata ready', {
      length: viewCore.length
    })
  }

  async _ensureMetadata() {
    await this.ready()
    await this._metadataReady
    if (!this.db) {
      throw new QvacErrorRegistryClient({
        code: ERR_CODES.FAILED_TO_CONNECT,
        adds: 'Registry database not available.'
      })
    }
  }

  async getModel(path, source) {
    this._validateString(path, 'path')
    this._validateString(source, 'source')

    try {
      this.logger.info('Getting model', { path, source })
      await this._ensureMetadata()

      const result = await this.db.getModel(path, source)
      this.logger.debug('getModel result', { result })
      return result ?? null
    } catch (error) {
      this.logger.error('Error getting model', error)
      throw error
    }
  }

  async findModels(query = {}, opts = {}) {
    await this._ensureMetadata()
    const { includeDeprecated = false } = opts
    this.logger.debug('findModels called', { query, includeDeprecated })

    let models = await this.db.findModelsByPath(query).toArray()

    if (!includeDeprecated) {
      models = models.filter((m) => !m.deprecated)
    }

    return models
  }

  async findModelsByEngine(query = {}) {
    await this._ensureMetadata()
    this.logger.debug('findModelsByEngine called', { query })
    return this.db.findModelsByEngine(query).toArray()
  }

  async findModelsByName(query = {}) {
    await this._ensureMetadata()
    this.logger.debug('findModelsByName called', { query })
    return this.db.findModelsByName(query).toArray()
  }

  async findModelsByQuantization(query = {}) {
    await this._ensureMetadata()
    this.logger.debug('findModelsByQuantization called', { query })
    return this.db.findModelsByQuantization(query).toArray()
  }

  /**
   * Find models with optional filters.
   * Uses the database's findBy method for efficient indexed queries.
   * @param {Object} params - Filter parameters
   * @param {string} [params.name] - Filter by name (partial match)
   * @param {string} [params.engine] - Filter by engine (exact match)
   * @param {string} [params.quantization] - Filter by quantization (partial match)
   * @param {boolean} [params.includeDeprecated=false] - Include deprecated models
   * @returns {Promise<Array>} Array of matching models
   */
  async findBy(params = {}) {
    await this._ensureMetadata()
    this.logger.debug('findBy called', { params })
    return this.db.findBy(params)
  }

  _validateString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Invalid ${name}: ${value}`)
    }
  }

  async _checkBlobProgress(core, blobPointer) {
    const totalBlocks = blobPointer.blockLength
    const totalBytes = blobPointer.byteLength

    if (totalBlocks === 0) {
      return { cachedBlocks: 0, totalBlocks: 0, totalBytes: 0 }
    }

    let cachedBlocks = 0
    for (let i = blobPointer.blockOffset; i < blobPointer.blockOffset + totalBlocks; i++) {
      const hasBlock = await core.has(i)
      if (hasBlock) cachedBlocks++
    }

    return { cachedBlocks, totalBlocks, totalBytes }
  }

  _decodeCoreKey(blobsCoreKey) {
    if (Buffer.isBuffer(blobsCoreKey)) return blobsCoreKey
    if (typeof blobsCoreKey === 'object' && blobsCoreKey.data) {
      return Buffer.from(blobsCoreKey.data)
    }
    return IdEnc.decode(blobsCoreKey)
  }

  _releaseId(coreKey, blockStart) {
    return `${IdEnc.normalize(coreKey)}:${blockStart}`
  }

  // A caller may start the next download of a blob before the previous one's
  // teardown finishes; clearing then would delete blocks the new one counted.
  // Loops because a clearBlob can register while we wait. Its error is its caller's.
  async _awaitPendingRelease(blobsCoreKey, blockStart) {
    const id = this._releaseId(this._decodeCoreKey(blobsCoreKey), blockStart)
    let pending = this._pendingReleases?.get(id)
    while (pending) {
      await pending.catch(() => {})
      pending = this._pendingReleases.get(id)
    }
  }

  async _getBlobsCore(blobsCoreKey) {
    const keyBuffer = this._decodeCoreKey(blobsCoreKey)

    this.logger.debug('Creating hyperblobs core', {
      blobCore: IdEnc.normalize(keyBuffer)
    })

    const core = this.corestore.get({ key: keyBuffer })
    await core.ready()

    const blobs = new Hyperblobs(core)
    await blobs.ready()

    return { core, blobs }
  }

  /**
   * Blocks while the swarm is suspended (app backgrounded), so a retry does not
   * fire against a swarm that cannot connect yet and exhaust the retry budget.
   * Bounded by RESUME_WAIT_MAX_MS; returns (and lets the retry proceed/fail) if
   * the runtime never resumes.
   */
  async _waitForSwarmResumed(signal) {
    if (!this.hyperswarm || !this.hyperswarm.suspended) return

    const start = Date.now()
    while (this.hyperswarm.suspended) {
      if (signal && signal.aborted) throw new Error('Download cancelled')
      if (Date.now() - start > RESUME_WAIT_MAX_MS) {
        this.logger.warn('Swarm still suspended after resume wait; retrying anyway')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_POLL_MS))
    }
  }

  /**
   * Blocks until at least one peer is replicating the core, so a retry after a
   * network drop waits for the network to actually return instead of firing
   * (and timing out) against zero peers and burning the retry budget. Bounded
   * by RESUME_WAIT_MAX_MS. No-op when peer info is unavailable.
   */
  async _waitForPeers(core, signal) {
    if (!core || !Array.isArray(core.peers)) return
    if (core.peers.length > 0) return

    const start = Date.now()
    while (core.peers.length === 0) {
      if (signal && signal.aborted) throw new Error('Download cancelled')
      if (Date.now() - start > RESUME_WAIT_MAX_MS) {
        this.logger.warn('No peers after reconnect wait; retrying anyway')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_POLL_MS))
    }
  }

  /**
   * Re-establish peers for a blobs core before retrying a download. After the
   * app backgrounds (or the network drops) the swarm connection for this core
   * is gone; this waits for the swarm to resume and for a peer to be replicating
   * the core, then re-runs the join + findingPeers + update sequence and awaits
   * it. Resume itself is cheap: the next attempt reuses the blocks already
   * cached in the core (the output file is re-streamed from those blocks, not
   * appended to).
   *
   * Honours `signal`: a foreground cancel during the (bounded but up to
   * RESUME_WAIT_MAX_MS) swarm/peer waits aborts promptly instead of blocking
   * until peers return or the cap elapses.
   */
  async _reconnectCore(core, signal) {
    if (!core || !this.hyperswarm) return
    if (signal && signal.aborted) throw new Error('Download cancelled')

    await this._waitForSwarmResumed(signal)

    this.logger.debug('Re-establishing peers before download retry', {
      discoveryKey: IdEnc.normalize(core.discoveryKey)
    })

    const done = core.findingPeers()
    this.hyperswarm.join(core.discoveryKey, { client: true, server: false })
    try {
      await this.hyperswarm.flush()
    } finally {
      done()
    }
    await this._waitForPeers(core, signal)
    await core.update()
  }

  async downloadModel(path, source, options = {}) {
    this._validateString(path, 'path')
    this._validateString(source, 'source')

    if (options && typeof options !== 'object') {
      throw new Error(`Invalid options: ${typeof options}`)
    }

    let core, blobs, blockStart, blockEnd, rangeDownload

    try {
      this.logger.info('Downloading model', { path, source })
      await this._ensureMetadata()

      const model = await this.getModel(path, source)
      if (!model) {
        throw new QvacErrorRegistryClient({
          code: ERR_CODES.MODEL_NOT_FOUND,
          adds: `Model not found: ${path} (source: ${source})`
        })
      }

      if (!model.blobBinding || !model.blobBinding.coreKey) {
        throw new QvacErrorRegistryClient({
          code: ERR_CODES.MODEL_NOT_FOUND,
          adds: 'Model missing blob binding'
        })
      }

      this.logger.debug('Model metadata retrieved', { model })

      await this._awaitPendingRelease(model.blobBinding.coreKey, model.blobBinding.blockOffset)
      const blobsCore = await this._getBlobsCore(model.blobBinding.coreKey)
      core = blobsCore.core
      blobs = blobsCore.blobs

      this.logger.debug('Joining swarm for blobs core', {
        discoveryKey: IdEnc.normalize(core.discoveryKey)
      })

      const foundBlobPeers = core.findingPeers()
      this.hyperswarm.join(core.discoveryKey, { client: true, server: false })
      this.hyperswarm.flush().then(() => foundBlobPeers())

      await core.update()
      this.logger.debug('Blobs core updated')

      const totalSize = model.blobBinding.byteLength

      rangeDownload = core.download({
        start: model.blobBinding.blockOffset,
        length: model.blobBinding.blockLength
      })

      blockStart = model.blobBinding.blockOffset
      blockEnd = blockStart + model.blobBinding.blockLength

      let artifact
      if (options.outputFile) {
        await withRetry(
          () => this._streamBlobToFile(blobs, core, model.blobBinding, options.outputFile, options),
          {
            maxRetries: options.maxRetries ?? DEFAULT_DOWNLOAD_MAX_RETRIES,
            retryCodes: RETRIABLE_DOWNLOAD_CODES,
            // Wait for the swarm to resume + reconnect peers before retrying,
            // so the retry doesn't immediately time out again against a dead
            // swarm (e.g. after the app backgrounded). The core's cached blocks
            // are not cleared until success, so the retry re-streams cheaply.
            beforeRetry: () => this._reconnectCore(core, options.signal),
            logger: this.logger
          }
        )
        artifact = { path: options.outputFile, totalSize }

        await this._releaseDownload(core, blobs, rangeDownload, blockStart, blockEnd)
      } else {
        const stream = blobs.createReadStream(model.blobBinding, {
          wait: true,
          timeout: options.timeout || 30000
        })
        artifact = { stream, totalSize }

        this._releaseOnStreamEnd(stream, core, blobs, rangeDownload, blockStart, blockEnd)
      }

      this.logger.info('Model downloaded successfully')

      return {
        model,
        artifact
      }
    } catch (error) {
      this.logger.error('Error downloading model', error)

      await this._releaseDownload(core, blobs, rangeDownload, blockStart, blockEnd, {
        clearBlocks: this._shouldClearBlocksAfterError(options)
      })

      throw error
    }
  }

  async downloadBlob(blobBinding, options = {}) {
    if (!blobBinding || !blobBinding.coreKey) {
      throw new Error('Invalid blobBinding: coreKey is required')
    }
    if (
      typeof blobBinding.blockOffset !== 'number' ||
      typeof blobBinding.blockLength !== 'number' ||
      typeof blobBinding.byteLength !== 'number'
    ) {
      throw new Error(
        'Invalid blobBinding: blockOffset, blockLength, and byteLength are required numbers'
      )
    }

    if (options && typeof options !== 'object') {
      throw new Error(`Invalid options: ${typeof options}`)
    }

    let core, blobs, blockStart, blockEnd, rangeDownload

    try {
      this.logger.info('Downloading blob directly', {
        coreKey:
          typeof blobBinding.coreKey === 'string'
            ? blobBinding.coreKey.slice(0, 12) + '...'
            : '(buffer)',
        blockOffset: blobBinding.blockOffset,
        blockLength: blobBinding.blockLength,
        byteLength: blobBinding.byteLength
      })

      await this.ready()

      await this._awaitPendingRelease(blobBinding.coreKey, blobBinding.blockOffset)
      const blobsCore = await this._getBlobsCore(blobBinding.coreKey)
      core = blobsCore.core
      blobs = blobsCore.blobs

      this.logger.debug('Joining swarm for blobs core (direct)', {
        discoveryKey: IdEnc.normalize(core.discoveryKey)
      })

      const foundBlobPeers = core.findingPeers()
      this.hyperswarm.join(core.discoveryKey, { client: true, server: false })
      this.hyperswarm.flush().then(() => foundBlobPeers())

      await core.update()
      this.logger.debug('Blobs core updated (direct)')

      const pointer = {
        blockOffset: blobBinding.blockOffset,
        blockLength: blobBinding.blockLength,
        byteOffset: blobBinding.byteOffset || 0,
        byteLength: blobBinding.byteLength
      }
      const totalSize = blobBinding.byteLength

      blockStart = pointer.blockOffset
      blockEnd = blockStart + pointer.blockLength

      rangeDownload = core.download({
        start: pointer.blockOffset,
        length: pointer.blockLength
      })

      let artifact
      if (options.outputFile) {
        await withRetry(
          () => this._streamBlobToFile(blobs, core, pointer, options.outputFile, options),
          {
            maxRetries: options.maxRetries ?? DEFAULT_DOWNLOAD_MAX_RETRIES,
            retryCodes: RETRIABLE_DOWNLOAD_CODES,
            // Wait for swarm resume + peer reconnect before retrying (see
            // downloadModel). Cached blocks are reused; the file is re-streamed.
            beforeRetry: () => this._reconnectCore(core, options.signal),
            logger: this.logger
          }
        )
        artifact = { path: options.outputFile, totalSize }

        await this._releaseDownload(core, blobs, rangeDownload, blockStart, blockEnd)
      } else {
        const stream = blobs.createReadStream(pointer, {
          wait: true,
          timeout: options.timeout || 30000
        })
        artifact = { stream, totalSize }

        this._releaseOnStreamEnd(stream, core, blobs, rangeDownload, blockStart, blockEnd)
      }

      this.logger.info('Blob download complete (direct)')

      return { artifact }
    } catch (error) {
      this.logger.error('Error downloading blob directly', error)

      await this._releaseDownload(core, blobs, rangeDownload, blockStart, blockEnd, {
        clearBlocks: this._shouldClearBlocksAfterError(options)
      })

      throw error
    }
  }

  _releaseOnStreamEnd(stream, core, blobs, rangeDownload, blockStart, blockEnd) {
    let released = false

    // 'close' also covers a destroyed or errored stream; on 'end' alone a
    // cancelled stream download would never free its blocks.
    const release = () => {
      if (released) return
      released = true
      return this._releaseDownload(core, blobs, rangeDownload, blockStart, blockEnd).catch((e) =>
        this.logger.warn('Error releasing blob resources', { error: e.message })
      )
    }

    stream.once('end', release)
    stream.once('close', release)
  }

  // A failed download keeps its blocks so the next attempt resumes from them;
  // `clearBlob` reclaims them. A cancel clears unless `clearBlocksOnCancel`
  // (read at cancel time) says otherwise.
  _shouldClearBlocksAfterError(options) {
    if (!options.signal || !options.signal.aborted) return false

    const clear = options.clearBlocksOnCancel
    if (clear === undefined) return true
    return Boolean(typeof clear === 'function' ? clear() : clear)
  }

  _releaseDownload(core, blobs, rangeDownload, blockStart, blockEnd, opts = {}) {
    const release = this._doReleaseDownload(core, blobs, rangeDownload, blockStart, blockEnd, opts)
    if (!core || !core.key || blockStart === undefined) return release

    return this._trackRelease(this._releaseId(core.key, blockStart), release)
  }

  _trackRelease(id, release) {
    this._pendingReleases ??= new Map()
    const tracked = release.finally(() => {
      if (this._pendingReleases.get(id) === tracked) this._pendingReleases.delete(id)
    })
    this._pendingReleases.set(id, tracked)
    return tracked
  }

  async _doReleaseDownload(core, blobs, rangeDownload, blockStart, blockEnd, opts) {
    const { clearBlocks = true, strict = false } = opts
    let clearError = null

    // Hypercore can commit in-flight responses after a range is destroyed.
    if (rangeDownload) rangeDownload.destroy()

    if (!clearBlocks && blockStart !== undefined) {
      this.logger.info('Keeping blob blocks for resume', { start: blockStart, end: blockEnd })
    } else if (core && blockStart !== undefined) {
      if (rangeDownload) await this._waitForInflightBlocks(core)
      try {
        await this._clearBlobBlocks(core, blockStart, blockEnd, { strict })
      } catch (err) {
        clearError = err
      }
    }
    if (blobs) {
      try {
        await blobs.close()
      } catch (e) {
        this.logger.warn('Error closing blob instance', { error: e.message })
      }
    }
    if (core) {
      try {
        await core.close()
      } catch (e) {
        this.logger.warn('Error closing blob core', { error: e.message })
      }
    }

    this.logger.debug('Blob resources released')
    if (clearError) throw clearError
  }

  async _waitForInflightBlocks(core) {
    if (!Array.isArray(core.peers)) return

    const timeoutMs = this._inflightDrainTimeoutMs ?? INFLIGHT_DRAIN_TIMEOUT_MS
    const pollMs = this._inflightDrainPollMs ?? INFLIGHT_DRAIN_POLL_MS
    const deadline = Date.now() + timeoutMs
    while (core.peers.some((peer) => peer.inflight > 0 || peer.dataProcessing > 0)) {
      if (Date.now() >= deadline) {
        this.logger.warn('Timed out waiting for in-flight blob blocks before clearing', {
          timeoutMs,
          peers: core.peers.map((peer, index) => ({
            peer: index,
            inflight: peer.inflight,
            dataProcessing: peer.dataProcessing
          }))
        })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  /**
   * Deletes a blob's cached blocks, e.g. those an abandoned download kept for
   * resume. No-op for blocks that were never downloaded.
   */
  async clearBlob(blobBinding) {
    if (!blobBinding || !blobBinding.coreKey) {
      throw new Error('Invalid blobBinding: coreKey is required')
    }
    if (
      typeof blobBinding.blockOffset !== 'number' ||
      typeof blobBinding.blockLength !== 'number'
    ) {
      throw new Error('Invalid blobBinding: blockOffset and blockLength are required numbers')
    }

    // Registered before the first await so a download called right after waits for it.
    const id = this._releaseId(this._decodeCoreKey(blobBinding.coreKey), blobBinding.blockOffset)
    const previous = this._pendingReleases?.get(id)
    await this._trackRelease(id, this._clearBlobNow(blobBinding, previous))
  }

  async _clearBlobNow(blobBinding, previous) {
    if (previous) await previous.catch(() => {})
    await this.ready()
    const { core, blobs } = await this._getBlobsCore(blobBinding.coreKey)
    // A cancel that kept its blocks skipped the drain; its in-flight blocks can still land.
    await this._waitForInflightBlocks(core)
    const start = blobBinding.blockOffset
    await this._doReleaseDownload(core, blobs, null, start, start + blobBinding.blockLength, {
      strict: true
    })
  }

  // Download cleanup is best-effort; `strict` lets an explicit clearBlob report failure.
  async _clearBlobBlocks(core, start, end, { strict = false } = {}) {
    try {
      const cleared = await core.clear(start, end, { diff: true })
      await core.compact()
      this.logger.info('Cleared blob blocks from corestore', {
        start,
        end,
        blocks: cleared ? cleared.blocks : end - start
      })
    } catch (err) {
      this.logger.warn('Failed to clear blob blocks from corestore', { error: err.message })
      if (strict) throw err
    }
  }

  async _streamBlobToFile(blobs, core, blobPointer, filePath, options) {
    const { cachedBlocks, totalBlocks, totalBytes } = await this._checkBlobProgress(
      core,
      blobPointer
    )

    this.logger.debug('Blob progress before download', {
      cachedBlocks,
      totalBlocks,
      totalBytes,
      resuming: cachedBlocks > 0 && cachedBlocks < totalBlocks
    })

    const bytesPerBlock = totalBlocks > 0 ? totalBytes / totalBlocks : 0
    let downloadedBytes = Math.floor(cachedBlocks * bytesPerBlock)

    if (options.onProgress && downloadedBytes > 0) {
      options.onProgress({
        downloaded: downloadedBytes,
        total: totalBytes,
        cachedBlocks,
        totalBlocks
      })
    }

    const progressHandler = (index, bytes) => {
      if (
        index >= blobPointer.blockOffset &&
        index < blobPointer.blockOffset + blobPointer.blockLength
      ) {
        downloadedBytes += bytes
        const capped = Math.min(downloadedBytes, totalBytes)
        if (options.onProgress) {
          options.onProgress({
            downloaded: capped,
            total: totalBytes,
            cachedBlocks,
            totalBlocks
          })
        }
      }
    }

    core.on('download', progressHandler)

    const rangeDownload = core.download({
      start: blobPointer.blockOffset,
      length: blobPointer.blockLength
    })

    const stream = blobs.createReadStream(blobPointer, {
      wait: true,
      timeout: options.timeout || 30000
    })

    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })

    const writeStream = fs.createWriteStream(filePath)

    try {
      await new Promise((resolve, reject) => {
        stream.pipe(writeStream)
        writeStream.on('finish', resolve)
        writeStream.on('error', reject)
        stream.on('error', reject)

        if (options.signal) {
          if (options.signal.aborted) {
            stream.destroy()
            writeStream.destroy()
            reject(new Error('Download cancelled'))
            return
          }
          options.signal.addEventListener(
            'abort',
            () => {
              stream.destroy()
              writeStream.destroy()
              reject(new Error('Download cancelled'))
            },
            { once: true }
          )
        }
      })
    } finally {
      rangeDownload.destroy()
      core.off('download', progressHandler)
    }
  }

  async suspend(opts = {}) {
    this.logger.debug('suspend called')

    if (!this.opened || this.closing) {
      this.logger.debug('Skipping suspend while client is not open or is closing')
      return
    }

    if (this.hyperswarm && !this.hyperswarm.suspended) {
      await this.hyperswarm.suspend(opts)
    }
    if (this.corestore) {
      await this.corestore.suspend(opts)
    }

    this.logger.debug('QVACRegistryClient suspended')
  }

  async resume(opts = {}) {
    this.logger.debug('resume called')

    if (!this.opened || this.closing) {
      this.logger.debug('Skipping resume while client is not open or is closing')
      return
    }

    if (this.corestore) {
      await this.corestore.resume()
    }
    if (this.hyperswarm && this.hyperswarm.suspended) {
      await this.hyperswarm.resume(opts)
    }

    this.logger.debug('QVACRegistryClient resumed')
  }

  async _close() {
    this.logger.debug('_close called')

    if (this._metadataReady) {
      await this._metadataReady.catch(() => {})
      this._metadataReady = null
    }

    if (this.db) {
      this.logger.debug('Closing database')
      await this.db.close()
      this.db = null
    }

    if (this.hyperswarm) {
      if (this._connectionHandler) {
        this.hyperswarm.off('connection', this._connectionHandler)
        this._connectionHandler = null
      }
      this.logger.debug('Destroying hyperswarm')
      await this.hyperswarm.destroy()
      this.hyperswarm = null
    }

    if (this.corestore) {
      this.logger.debug('Closing corestore')
      await this.corestore.close()
      this.corestore = null
    }

    this.logger.debug('QVACRegistryClient closed')
  }
}

module.exports = QVACRegistryClient
