'use strict'

const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const path = require('bare-path')
const BaseDL = require('@qvac/dl-base')
const { decode } = require('hypercore-id-encoding')
const getTmpDir = require('test-tmp')
const HyperdriveProgressTracker = require('./src/HyperdriveProgressTracker')
const { QvacErrorBase } = require('@qvac/error')
const { QvacErrorHyperdrive, ERR_CODES } = require('./src/lib/error')
const ProgressReport = require('@qvac/infer-base/src/utils/progressReport')

/**
 * @typedef {Object} HyperDriveOptions
 * @property {string} [key] - The key for the Hyperdrive, must start with the `hd://` prefix.
 * @property {Corestore} [store] - An optional Corestore instance. If not provided, a new Corestore using RAM will be created.
 * @property {Hyperdrive} [drive] - An optional Hyperdrive instance. If not provided, a new Hyperdrive instance will be created.
 */

/**
 * HyperDriveDL is a data loader class for handling Hyperdrive-based downloads.
 * @extends {BaseDL}
 */
class HyperDriveDL extends BaseDL {
  /**
   * Create a new HyperDriveDL instance.
   * @param {HyperDriveOptions} opts - Options for the Hyperdrive downloader.
   * @throws {QvacErrorHyperdrive} If opts is not an object, doesn't contain a key, or if the key is invalid.
   */
  constructor (opts) {
    super(opts)

    const { key, drive } = opts || {}
    if (!drive) {
      if (!key) {
        throw new QvacErrorHyperdrive({ code: ERR_CODES.KEY_OR_DRIVE_REQUIRED })
      }

      this.opts.prefix ??= 'hd://'
      this.logger.debug('Using key prefix', { prefix: this.opts.prefix })

      if (!key.startsWith(this.opts.prefix)) {
        this.logger.error('Key does not start with prefix', { key: opts.key, prefix: this.opts.prefix })
        throw new QvacErrorHyperdrive({ code: ERR_CODES.KEY_INVALID, adds: 'Key must start with ' + this.opts.prefix })
      }
    }

    this.logger.debug('HyperDriveDL initialized', { key: opts.key })
  }

  _validateAndDecodeKey (key) {
    this.logger.debug('Validating and decoding key', { key })
    try {
      const decoded = key.startsWith('0x')
        ? decode(key.slice(2))
        : decode(key)

      this.logger.debug('Key decoded successfully', { decodedKey: decoded })
      return decoded
    } catch (err) {
      this.logger.error('Failed to decode key', { key, error: err })
      throw new QvacErrorHyperdrive({ code: ERR_CODES.KEY_INVALID, adds: err.message, cause: err })
    }
  }

  /**
   * Start the Hyperdrive client.
   * After initialization data loader guarantees to have the latest known snapshot of available file records.
   * @returns {Promise<void>}
   */
  async _open () {
    try {
      if (this.opts.drive) {
        this.drive = this.opts.drive
        return
      }

      this.logger.info('Opening Hyperdrive client', { key: this.opts.key })
      const keyWithoutPrefix = this.opts.key.substring(this.opts.prefix.length)
      this.logger.debug('Stripped prefix from key', { keyWithoutPrefix })

      let store = this.opts.store
      if (store) {
        this.logger.debug('Using provided Corestore instance')
      } else {
        this.logger.debug('No Corestore provided, creating temp Corestore')
        const tmpDir = await getTmpDir()
        this.logger.debug('Temporary directory for Corestore', { tmpDir })
        store = new Corestore(tmpDir)
      }

      const bufferStoreKey = this._validateAndDecodeKey(keyWithoutPrefix)
      this.client = new Hyperdrive(store, bufferStoreKey)
      this.logger.debug('Hyperdrive client created', {
        key: this.client.key?.toString('hex')
      })
      if (!this.swarm) {
        this.logger.debug('Initializing Hyperswarm')
        this.swarm = new Hyperswarm()
        store.on('close', () => {
          this.logger.debug('Store closed, destroying swarm')
          this.swarm.destroy()
        })
      }
      this.swarm.on('connection', conn => {
        this.logger.debug('New swarm connection, replicating store')
        store.replicate(conn)
      })

      try {
        await this.client.ready()
        this.logger.debug('Hyperdrive client ready', {
          version: this.client.version
        })
      } catch (err) {
        throw new QvacErrorHyperdrive({ code: ERR_CODES.DRIVE_NOT_READY, cause: err })
      }

      this.swarm.join(this.client.discoveryKey, { client: true, server: false })
      this.logger.debug('Joined hyperswarm', {
        discoveryKey: this.client.discoveryKey.toString('hex')
      })

      let version
      if (this.opts.version) {
        version = this.opts.version
        this.logger.debug('Using provided version', { version })
      } else {
        this.logger.debug(
          'No version provided, fetching blobs and waiting for peers'
        )
        const done = store.findingPeers()
        // Awaiting this promise is unnecessary and slow
        this.swarm.flush().then(done, done)
        await this.client.getBlobs()
        version = this.client.version
        this.logger.debug('Fetched blobs and determined latest version', {
          version
        })
      }

      this.drive = this.client.checkout(version)
      this.logger.debug('Checked out drive at version', { version })
    } catch (err) {
      this.logger.error('Failed to open Hyperdrive client', { error: err })
      if (
        Object.getPrototypeOf(err)?.constructor?.name === QvacErrorBase.name
      ) {
        throw err
      }
      throw new QvacErrorHyperdrive({ code: ERR_CODES.CONNECTION_FAILED, cause: err })
    }
  }

  /**
   * Stop the Hyperdrive client.
   * @returns {Promise<void>}
   */
  async _close () {
    this.logger.info('Closing Hyperdrive client')
    if (this.drive) {
      this.logger.debug('Closing drive')
      await this.drive.close()
      this.logger.info('Drive closed')
    }
    if (this.client) {
      this.logger.debug('Closing client')
      await this.client.close()
      this.logger.info('Client closed')
    }
  }

  /**
   * Get a file as async iterable buffer stream.
   * @param {string} filePath - The file path inside the Hyperdrive.
   * @returns {Promise<AsyncIterable<Buffer>>} The file content as async iterable.
   */
  async getStream (filePath, opts = {}) {
    try {
      if (!this.drive) {
        throw new QvacErrorHyperdrive({ code: ERR_CODES.DRIVE_NOT_READY })
      }
      this.drive.download(filePath)

      this.logger.debug('getStream requested', { filePath, opts })
      return this.drive.createReadStream(filePath, opts)
    } catch (err) {
      this.logger.error('Failed to get stream for file', { filePath, error: err })
      if (err instanceof QvacErrorHyperdrive) {
        throw err
      }
      throw new QvacErrorHyperdrive({ code: ERR_CODES.FILE_NOT_FOUND, adds: `${filePath}: ${err.message}`, cause: err })
    }
  }

  /**
   * Get the size of a file in bytes.
   * @param {string} filePath - The file path inside the Hyperdrive.
   * @returns {Promise<number>} The size of the file in bytes.
   */
  async getFileSize (path, opts = {}) {
    try {
      if (!this.drive) {
        throw new QvacErrorHyperdrive({ code: ERR_CODES.DRIVE_NOT_READY })
      }

      this.logger.debug('getFileSize called', { path, opts })
      const entry = await this.drive.entry(path, opts)
      if (entry?.value?.blob) {
        const size = entry.value.blob.byteLength
        this.logger.info('File size retrieved', { path, size })
        return size
      } else {
        throw new QvacErrorHyperdrive({ code: ERR_CODES.FILE_NOT_FOUND, adds: path })
      }
    } catch (err) {
      this.logger.error('File not found', { path })

      if (err instanceof QvacErrorHyperdrive) {
        throw err
      }

      throw new QvacErrorHyperdrive({ code: ERR_CODES.FILE_NOT_FOUND, adds: path, cause: err })
    }
  }

  /**
   * Check if all files in a given directory are cached.
   * @param {string} [directoryPath='/'] - The directory to check.
   * @returns {Promise<boolean>} True if all files are cached, false otherwise.
   */
  async cached (path = '/') {
    try {
      this.logger.debug('Checking if path is cached', { path })
      this._checkDrive()

      const result = await this.drive.has(path)
      this.logger.debug('Cache status', { path, cached: result })
      return result
    } catch (err) {
      if (
        Object.getPrototypeOf(err)?.constructor?.name === QvacErrorBase.name
      ) {
        throw err
      }
      throw new QvacErrorHyperdrive({ code: ERR_CODES.CONNECTION_FAILED, cause: err })
    }
  }

  /**
   * List the files in a given directory in the Hyperdrive.
   * @param {string} [directoryPath='/'] - The directory to list files from.
   * @returns {Promise<Array<{key: string, cached?: boolean}>>} A list of files with their keys and cache status.
   */
  async list (directoryPath = '/', opts = {}) {
    try {
      this._checkDrive()
      this.logger.debug('Listing files in directory', { directoryPath, opts })

      const filesStream = this.drive.list(directoryPath, {
        ...opts,
        recursive: true
      })

      const files = []
      for await (const file of filesStream) {
        const fl = { key: file.key }
        if (await this.cached(file.key)) {
          fl.cached = true
        }

        this.logger.debug('List entry', { file: fl })
        files.push(fl)
      }

      this.logger.debug('Directory listing complete', {
        directory: directoryPath,
        count: files.length
      })
      return files
    } catch (err) {
      this.logger.error('Failed to list directory', {
        directoryPath,
        error: err
      })

      if (
        Object.getPrototypeOf(err)?.constructor?.name === QvacErrorBase.name
      ) {
        throw err
      }
      throw new QvacErrorHyperdrive({ code: ERR_CODES.CONNECTION_FAILED, cause: err })
    }
  }

  /**
   * Downloads file to local drive cache based on supplied path.
   * Can optionally save files directly to disk using the diskPath option.
   * @param {string} [remotePath='/'] - The path to download the file from.
   * @param {Object|ProgressReport} [opts] - Options object or legacy ProgressReport instance.
   * @param {string} [opts.diskPath] - Path to save files to disk instead of cache.
   * @param {ProgressReport} [opts.progressReporter] - Progress reporter instance.
   * @param {Function} [opts.progressCallback] - Progress callback function.
   * @returns {Promise<HyperDriveDownload>} Download object with trackers, await function that returns download results, and cancel function.
   */
  async download (remotePath = '/', opts = null) {
    let progressReport = null
    let diskPath = null

    if (opts instanceof ProgressReport) {
      progressReport = opts
      opts = null
    } else if (opts && typeof opts === 'object') {
      diskPath = opts?.diskPath
      progressReport = opts?.progressReporter

      if (opts.progressCallback && typeof opts.progressCallback === 'function' && opts.progressReporter) {
        this.logger.warn('Progress report provided, but progress callback is also provided. Ignoring progress report.')
      }
    }

    try {
      this.logger.debug('download called', { remotePath })
      this._checkDrive()

      if (await this.cached(remotePath) && !diskPath) {
        this.logger.debug('Path already cached, skipping download', { remotePath })
        return false
      }

      const files = await this._getFilesToDownload(remotePath)

      // If user provides a progress callback, we initialize a progress report
      if (opts?.progressCallback && typeof opts.progressCallback === 'function') {
        progressReport = await this.initProgressReport(files, opts.progressCallback)
      }

      this.logger.debug('Files to download', { files })

      const trackers = []
      const downloadPromises = []
      for (const file of files) {
        const tracker = new HyperdriveProgressTracker(
          this.drive,
          file,
          this.logger,
          progressReport,
          diskPath
        )
        downloadPromises.push(tracker
          .downloadStart()
          .then(() => {
            this.logger.debug('Download completed', { file })
            return { file, error: null, cached: false }
          })
          .catch(err => {
            this.logger.error('Download failed', { file, error: err })
            return { file, error: err, cached: false }
          }))
        trackers.push(tracker)
      }

      this.logger.debug('Background downloads started', { count: files.length })

      return {
        trackers,
        await: async () => {
          return await Promise.all(downloadPromises)
        },
        cancel: async () => {
          for (const tracker of trackers) {
            await tracker.cancel()
          }
        }
      }
    } catch (err) {
      this.logger.error('Download failed', { path, error: err })
      if (
        Object.getPrototypeOf(err)?.constructor?.name === QvacErrorBase.name
      ) {
        throw err
      }
      throw new QvacErrorHyperdrive({
        code: ERR_CODES.DOWNLOAD_FAILED,
        adds: `${remotePath}: ${err.message}`,
        cause: err
      })
    }
  }

  async _getFilesToDownload (path) {
    try {
      this.logger.debug('_getFilesToDownload called', { path })

      if (path.endsWith('/')) {
        const fileList = await this.list(path)
        const files = fileList.map(file => file.key)
        this.logger.debug('Determined files to download', { files })

        return files
      }

      return [path]
    } catch (err) {
      this.logger.error('Failed to get files for download', { path, error: err })
      if (Object.getPrototypeOf(err)?.constructor?.name === QvacErrorBase.name) {
        throw err
      }
      throw new QvacErrorHyperdrive({ code: ERR_CODES.CONNECTION_FAILED, cause: err })
    }
  }

  async initProgressReport (filePaths, progressCallback) {
    if (typeof progressCallback !== 'function') {
      this.logger?.warn('Progress report skipped - no callback provided')
      return null
    }
    const filesizeMapping = {}
    await Promise.all(
      filePaths.map(async fp => {
        const name = path.basename(fp)
        const size = await this.getFileSize(fp)
        filesizeMapping[name] = size
      })
    )
    this.logger?.info(
      `Progress report initialized for ${filePaths.length} file(s)`
    )
    return new ProgressReport(filesizeMapping, progressCallback)
  }

  /**
   * Deletes weights if present on local storage.
   * Returns true if deleted and false if file not found
   * @param {string} path - The path to delete the file from.
   * @returns {Promise<boolean>} True if deleted, false if no file found.
   */
  async deleteLocal (path = '/', opts = {}) {
    try {
      this.logger.debug('deleteLocal called', { path, opts })
      this._checkDrive()

      if (await this.cached(path)) {
        if (path && path === '/') {
          this.logger.debug('Clearing all drive contents')

          await this.drive.clearAll()
        } else {
          this.logger.debug('Clearing specific path', { path })

          await this.drive.clear(path, opts)
        }
        this.logger.debug('Deletion successful', { path })

        return true
      } else {
        this.logger.debug('No cached data to delete', { path })
        return false
      }
    } catch (err) {
      this.logger.error('Failed to delete local data', { path, error: err })
      if (err instanceof QvacErrorHyperdrive) {
        throw err
      }
      throw new QvacErrorHyperdrive({ code: ERR_CODES.CONNECTION_FAILED, cause: err })
    }
  }

  /**
   * Check if the drive is ready.
   */
  _checkDrive () {
    if (!this.drive) {
      throw new QvacErrorHyperdrive({ code: ERR_CODES.DRIVE_NOT_READY })
    }
  }
}

module.exports = HyperDriveDL
