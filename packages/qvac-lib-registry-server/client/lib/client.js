'use strict'

const { QvacErrorRegistryClient, ERR_CODES } = require('../utils/error')
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

class QVACRegistryClient extends ReadyResource {
  constructor (opts = {}) {
    super()

    this.logger = new Logger(opts.logger)
    this.registryConfig = new RegistryConfig({ logger: this.logger })

    this.db = null
    this.corestore = null
    this.hyperswarm = null
    this._connectionHandler = null
    this._metadataReady = null

    this.storage = this.registryConfig.getRegistryStorage(opts.storage)
    this.registryCoreKey = this.registryConfig.getRegistryCoreKey(opts.registryCoreKey)

    this.logger.debug('Initializing QVAC Registry Client', {
      mode: 'read',
      registryCoreKey: opts.registryCoreKey ? '***' : 'not provided'
    })

    this.ready()
  }

  async _open () {
    this.logger.debug('_open called')

    this.logger.debug('Creating corestore for open')
    this.corestore = new Corestore(this.storage)
    await this.corestore.ready()

    this.logger.debug('Creating Hyperswarm for open')
    this.hyperswarm = new Hyperswarm()

    this._connectionHandler = (conn, peerInfo) => {
      this.logger.debug('Client peer connected', { peer: IdEnc.normalize(peerInfo.publicKey) })
      this.corestore.replicate(conn)
    }
    this.hyperswarm.on('connection', this._connectionHandler)

    this._metadataReady = this._connectMetadataCore()
  }

  async _connectMetadataCore () {
    if (!this.registryCoreKey) {
      this.logger.error('Missing registry core key for read mode')
      throw new QvacErrorRegistryClient({ code: ERR_CODES.FAILED_TO_CONNECT, adds: 'Missing registry core key. Set QVAC_REGISTRY_CORE_KEY environment variable.' })
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

  async _ensureMetadata () {
    await this.ready()
    await this._metadataReady
    if (!this.db) {
      throw new QvacErrorRegistryClient({ code: ERR_CODES.FAILED_TO_CONNECT, adds: 'Registry database not available.' })
    }
  }

  async getModel (path, source) {
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

  async findModels (query = {}, opts = {}) {
    await this._ensureMetadata()
    const { includeDeprecated = false } = opts
    this.logger.debug('findModels called', { query, includeDeprecated })

    let models = await this.db.findModelsByPath(query).toArray()

    if (!includeDeprecated) {
      models = models.filter(m => !m.deprecated)
    }

    return models
  }

  async findModelsByEngine (query = {}) {
    await this._ensureMetadata()
    this.logger.debug('findModelsByEngine called', { query })
    return this.db.findModelsByEngine(query).toArray()
  }

  async findModelsByName (query = {}) {
    await this._ensureMetadata()
    this.logger.debug('findModelsByName called', { query })
    return this.db.findModelsByName(query).toArray()
  }

  async findModelsByQuantization (query = {}) {
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
  async findBy (params = {}) {
    await this._ensureMetadata()
    this.logger.debug('findBy called', { params })
    return this.db.findBy(params)
  }

  _validateString (value, name) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Invalid ${name}: ${value}`)
    }
  }

  async _checkBlobProgress (core, blobPointer) {
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

  async _getBlobsCore (blobsCoreKey) {
    let keyBuffer
    if (Buffer.isBuffer(blobsCoreKey)) {
      keyBuffer = blobsCoreKey
    } else if (typeof blobsCoreKey === 'object' && blobsCoreKey.data) {
      keyBuffer = Buffer.from(blobsCoreKey.data)
    } else {
      keyBuffer = IdEnc.decode(blobsCoreKey)
    }

    this.logger.debug('Creating hyperblobs core', {
      blobCore: IdEnc.normalize(keyBuffer)
    })

    const core = this.corestore.get({ key: keyBuffer })
    await core.ready()

    const blobs = new Hyperblobs(core)
    await blobs.ready()

    return { core, blobs }
  }

  async downloadModel (path, source, options = {}) {
    this._validateString(path, 'path')
    this._validateString(source, 'source')

    if (options && typeof options !== 'object') {
      throw new Error(`Invalid options: ${typeof options}`)
    }

    let core, blobs

    try {
      this.logger.info('Downloading model', { path, source })
      await this._ensureMetadata()

      const model = await this.getModel(path, source)
      if (!model) {
        throw new QvacErrorRegistryClient({ code: ERR_CODES.MODEL_NOT_FOUND, adds: `Model not found: ${path} (source: ${source})` })
      }

      if (!model.blobBinding || !model.blobBinding.coreKey) {
        throw new QvacErrorRegistryClient({ code: ERR_CODES.MODEL_NOT_FOUND, adds: 'Model missing blob binding' })
      }

      this.logger.debug('Model metadata retrieved', { model })

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

      let artifact
      if (options.outputFile) {
        await this._streamBlobToFile(blobs, core, model.blobBinding, options.outputFile, options)
        artifact = { path: options.outputFile, totalSize }

        if (blobs) await blobs.close()
        if (core) await core.close()
      } else {
        const stream = blobs.createReadStream(model.blobBinding, {
          wait: true,
          timeout: options.timeout || 30000
        })
        artifact = { stream, totalSize }

        const cleanup = async () => {
          if (blobs) {
            try {
              await blobs.close()
            } catch (cleanupError) {
              this.logger.warn('Error closing blob instance', { error: cleanupError.message })
            }
          }
          if (core) {
            try {
              await core.close()
            } catch (cleanupError) {
              this.logger.warn('Error closing blob core', { error: cleanupError.message })
            }
          }
          this.logger.debug('Blob resources closed after stream end')
        }

        stream.on('close', cleanup)
      }

      this.logger.info('Model downloaded successfully')

      return {
        model,
        artifact
      }
    } catch (error) {
      this.logger.error('Error downloading model', error)

      if (blobs) {
        try {
          await blobs.close()
        } catch (cleanupError) {
          this.logger.warn('Error closing blob instance on error', { error: cleanupError.message })
        }
      }
      if (core) {
        try {
          await core.close()
        } catch (cleanupError) {
          this.logger.warn('Error closing blob core on error', { error: cleanupError.message })
        }
      }

      throw error
    }
  }

  async downloadBlob (blobBinding, options = {}) {
    if (!blobBinding || !blobBinding.coreKey) {
      throw new Error('Invalid blobBinding: coreKey is required')
    }
    if (typeof blobBinding.blockOffset !== 'number' ||
        typeof blobBinding.blockLength !== 'number' ||
        typeof blobBinding.byteLength !== 'number') {
      throw new Error('Invalid blobBinding: blockOffset, blockLength, and byteLength are required numbers')
    }

    if (options && typeof options !== 'object') {
      throw new Error(`Invalid options: ${typeof options}`)
    }

    let core, blobs

    try {
      this.logger.info('Downloading blob directly', {
        coreKey: typeof blobBinding.coreKey === 'string' ? blobBinding.coreKey.slice(0, 12) + '...' : '(buffer)',
        blockOffset: blobBinding.blockOffset,
        blockLength: blobBinding.blockLength,
        byteLength: blobBinding.byteLength
      })

      await this.ready()

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

      let artifact
      if (options.outputFile) {
        await this._streamBlobToFile(blobs, core, pointer, options.outputFile, options)
        artifact = { path: options.outputFile, totalSize }

        if (blobs) await blobs.close()
        if (core) await core.close()
      } else {
        const stream = blobs.createReadStream(pointer, {
          wait: true,
          timeout: options.timeout || 30000
        })
        artifact = { stream, totalSize }

        const cleanup = async () => {
          if (blobs) {
            try { await blobs.close() } catch (e) {
              this.logger.warn('Error closing blob instance', { error: e.message })
            }
          }
          if (core) {
            try { await core.close() } catch (e) {
              this.logger.warn('Error closing blob core', { error: e.message })
            }
          }
          this.logger.debug('Blob resources closed after stream end')
        }

        stream.on('close', cleanup)
      }

      this.logger.info('Blob download complete (direct)')

      return { artifact }
    } catch (error) {
      this.logger.error('Error downloading blob directly', error)

      if (blobs) {
        try { await blobs.close() } catch (e) {
          this.logger.warn('Error closing blob instance on error', { error: e.message })
        }
      }
      if (core) {
        try { await core.close() } catch (e) {
          this.logger.warn('Error closing blob core on error', { error: e.message })
        }
      }

      throw error
    }
  }

  async _streamBlobToFile (blobs, core, blobPointer, filePath, options) {
    const { cachedBlocks, totalBlocks, totalBytes } = await this._checkBlobProgress(core, blobPointer)

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
      if (index >= blobPointer.blockOffset && index < blobPointer.blockOffset + blobPointer.blockLength) {
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
          options.signal.addEventListener('abort', () => {
            stream.destroy()
            writeStream.destroy()
            reject(new Error('Download cancelled'))
          }, { once: true })
        }
      })
    } finally {
      core.off('download', progressHandler)
    }
  }

  async _close () {
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
