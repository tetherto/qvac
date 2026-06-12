'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const ProgressReport = require('../src/utils/progressReport')
const { QvacInferenceBaseError, ERR_CODES } = require('../src/error')

/**
 * WeightsProvider handles downloading, streaming, and config retrieval,
 * including progress reporting.
 */
class WeightsProvider {
  /**
   * @param {Loader} loader  // external loader instance
   * @param {Logger} logger  // optional logger
   */
  constructor (loader, logger) {
    this.loader = loader
    this.logger = logger
  }

  /**
   * Initializes a progress report for given files.
   * @param {string[]} filePaths
   * @param {Function} callback
   * @returns {ProgressReport|null}
   */
  async initProgressReport (filePaths, callback) {
    if (typeof this.loader.getFileSize !== 'function') {
      this.logger?.warn('Progress report skipped - loader missing getFileSize')
      return null
    }
    if (typeof callback !== 'function') {
      this.logger?.warn('Progress report skipped - no callback provided')
      return null
    }
    const filesizeMapping = {}
    await Promise.all(
      filePaths.map(async fp => {
        const name = path.basename(fp)
        const size = await this.loader.getFileSize(fp)
        filesizeMapping[name] = size
      })
    )
    this.logger?.info(
      `Progress report initialized for ${filePaths.length} file(s)`
    )
    return new ProgressReport(filesizeMapping, callback)
  }

  /**
   * Download weights file to disk with progress.
   * @param {string[]} fileNames
   * @param {string} diskPath
   * @param {Object} options
   * @param {boolean} [options.closeLoader=true]
   * @param {Function} [options.onDownloadProgress]
   * @returns {Promise<Record<string,{filePath: string|null, error: boolean, completed: boolean}>>} Map of filenames to download results
   */
  async downloadFiles (fileNames, diskPath, { closeLoader = true, onDownloadProgress = () => { } } = {}) {
    await this.loader.ready()

    const progressReporter = await this.initProgressReport(
      fileNames,
      onDownloadProgress
    )

    fs.mkdirSync(path.dirname(diskPath), { recursive: true })
    const response = {}

    for (const fileName of fileNames) {
      try {
        const fileExists = fs.existsSync(path.join(diskPath, fileName))

        if (fileExists) {
          this.logger?.info(`File ${fileName} already exists, skipping download`)
          response[fileName] = { filePath: path.join(diskPath, fileName), error: false, completed: true }
        } else {
          await this._downloadFile(fileName, diskPath, progressReporter)
          response[fileName] = { filePath: fileName, error: false, completed: true }
        }
      } catch (error) {
        this.logger?.error(`Error downloading file ${fileName}: ${error}`)
        response[fileName] = { filePath: null, error: true, completed: false }

        // throw error to stop the process for now but we could implement a retry mechanism,
        // or lifecycle with onDownloadError callback to allow user to handle download errors
        throw new QvacInferenceBaseError({ code: ERR_CODES.DOWNLOAD_FAILED, adds: error, cause: error })
      }
    }

    if (closeLoader) {
      await this.loader.close()
    }

    return response
  }

  /**
   * Downloads a single file from the loader to disk
   * @param {string} fileName - Name of the file to download
   * @param {string} diskPath - Path on disk where file should be saved
   * @param {ProgressReport} progressReporter - Progress reporter instance to track download progress
   * @returns {Promise<void>}
   * @private
   */
  async _downloadFile (fileName, diskPath, progressReporter) {
    await this.loader.ready()

    if (typeof this.loader.download !== 'function') {
      throw new QvacInferenceBaseError({ code: ERR_CODES.LOAD_NOT_IMPLEMENTED, adds: 'download' })
    }

    try {
      const response = await this.loader.download(fileName, { diskPath, progressReporter })
      // response can be false if the file is already downloaded
      if (response && typeof response.await === 'function') {
        await response.await()
      }
    } catch (error) {
      this.logger?.error(`Error downloading file ${fileName}: ${error}`)
      throw new QvacInferenceBaseError({ code: ERR_CODES.DOWNLOAD_FAILED, adds: error, cause: error })
    }
  }

  /**
   * @param {string} baseShardFilepath - Path to one of the sharded files, for example `path/SmolLM2-135M-Instruct-IQ3_XS-00001-of-00002.gguf`.
   * @return Returns list of all shards if the file path correspond to a sharded model. It also includes the `*tensors.txt` file.
   */
  static expandGGUFIntoShards (baseShardFilepath) {
    const shardPattern = /^(.+)-(\d+)-of-(\d+)\.gguf$/
    const match = shardPattern.exec(path.basename(baseShardFilepath))

    if (!match) {
      // Not a sharded file
      return null
    }

    const [, basename, , totalShards] = match
    const totalShardsNum = parseInt(totalShards, NaN)
    if (isNaN(totalShardsNum)) {
      // (Number) pattern does not follow a sharded file
      return null
    }

    const files = []
    files.push(`${basename}.tensors.txt`)

    for (let i = 1; i <= totalShardsNum; i++) {
      const shardNumber = i.toString().padStart(5, '0')
      files.push(`${basename}-${shardNumber}-of-${totalShards.toString().padStart(5, '0')}.gguf`)
    }

    return files
  }

  /**
   * Stream weights to consumer with progress.
   * @param {string|object|array} source(s)
   * @param {Function} onChunk
   * @param {Function} onProgress
   */
  async streamFiles (source, onChunk, onProgress = () => { }, progress = null) {
    let loaderStream, filename, sourcePath
    if (typeof source === 'string') {
      sourcePath = source
      filename = path.basename(source)
      loaderStream = await this.loader.getStream(sourcePath)
    } else if (Array.isArray(source)) {
      // Initialize common progress report for all files in
      // the array
      if (progress == null) {
        progress =
          await this.initProgressReport(
            source,
            onProgress,
            progress
          )
      }
      // Stream sources one after the other to avoid host
      // memory peaks when downloading in parallel.
      for (const s of source) {
        await this.streamFiles(s, onChunk, onProgress, progress)
      }
      return
    } else {
      loaderStream = source
      filename = source.filename || 'weights'
      sourcePath = filename
    }

    if (progress == null) {
      progress = await this.initProgressReport(
        [sourcePath],
        onProgress
      )
    }

    for await (const chunk of loaderStream) {
      onChunk({ filename, chunk, completed: false })
      onProgress(chunk.length)
      if (progress) progress.update(filename, chunk.length)
    }

    onChunk({ filename, chunk: null, completed: true })
    if (progress) progress.completeFile(filename)
    this.logger?.info(`Streamed weights for ${filename}`)
  }

  /**
   * Retrieve multiple config files as buffers
   * @param {string[]} configPaths
   * @returns {Promise<Record<string, Buffer>>}
   */
  async getConfigs (configPaths) {
    const configs = {}
    for (const fp of configPaths) {
      const chunks = []
      const stream = await this.loader.getStream(fp)
      for await (const c of stream) {
        chunks.push(c)
      }
      configs[fp] = Buffer.concat(chunks)
    }
    return configs
  }
}

module.exports = WeightsProvider
