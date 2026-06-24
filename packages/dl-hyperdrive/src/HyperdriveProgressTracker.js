'use strict'

const { QvacErrorHyperdrive, ERR_CODES } = require('./lib/error')
const fs = require('bare-fs')
const path = require('bare-path')

class HyperdriveProgressTracker {
  /**
   * @param {Hyperdrive} drive - A Hyperdrive instance.
   * @param {string} file - The file key to download.
   * @param logger QvacLogger - A logger instance for logging progress.
   * @param {ProgressReport} [progressReport] - Optional progress reporter.
   * @param {string} [diskPath] - Optional path to save file to disk instead of cache.
   */
  constructor (drive, file, logger, progressReport = null, diskPath = null) {
    this.drive = drive
    this.file = file
    this.logger = logger
    this.progressReport = progressReport
    this.diskPath = diskPath
    this.progressReportInterval = progressReport?.progressReportInterval ?? 100
    this.download = null

    this.logger.debug('HyperdriveProgressTracker initialized', {
      file: this.file,
      hasProgressReport: !!progressReport,
      hasDiskPath: !!diskPath,
      intervalMs: this.progressReportInterval
    })
  }

  /**
   * Kick off download of a single file, with progress reporting.
   */
  async downloadStart () {
    this.logger.debug('downloadStart called', { file: this.file })
    this.logger.debug('Reporting initial 0 bytes downloaded', {
      file: this.file
    })

    if (this.diskPath) {
      await this._saveFileToDisk(this.file, this.diskPath)
    } else {
      this.progressReport?.update(this.file, 0)
      await this._downloadSingleFile(this.file)
      this.logger.debug('Marking file complete in progressReport', {
        file: this.file
      })
      this.progressReport?.completeFile(this.file)
    }
  }

  async _saveFileToDisk (remotePath, diskPath) {
    try {
      this.logger.debug('saveFileToDisk called', { remotePath, diskPath })
      const fileName = path.basename(remotePath)
      const tempFilename = `${fileName}.part`
      const tempDestinationPath = path.join(diskPath, tempFilename)
      const destPath = path.join(diskPath, fileName)

      this.logger.debug('File paths determined', {
        remotePath,
        fileName,
        destPath,
        tempDestinationPath
      })

      try {
        fs.mkdirSync(diskPath, { recursive: true })
      } catch (err) {
        this.logger.error('Failed to create directory', {
          diskPath,
          error: err
        })
        throw new QvacErrorHyperdrive({
          code: ERR_CODES.DOWNLOAD_FAILED,
          adds: `Failed to create directory: ${err.message}`,
          cause: err
        })
      }

      let writeStream, loaderStream
      try {
        writeStream = fs.createWriteStream(tempDestinationPath)
        this.download = this.drive.download(remotePath)
        loaderStream = this.drive.createReadStream(remotePath)
      } catch (err) {
        this.logger.error('Failed to initialize download streams', {
          remotePath,
          error: err
        })
        if (writeStream) {
          writeStream.destroy()
        }
        throw new QvacErrorHyperdrive({
          code: ERR_CODES.FILE_NOT_FOUND,
          adds: `Failed to access file: ${remotePath}`,
          cause: err
        })
      }

      await new Promise((resolve, reject) => {
        loaderStream.pipe(writeStream)

        loaderStream.on('data', chunk => {
          try {
            if (this.progressReport) {
              this.progressReport.update(fileName, chunk.length)
            }
          } catch (err) {
            this.logger.error('Progress reporter error', { error: err })
          }
        })

        writeStream.on('finish', () => {
          try {
            fs.renameSync(tempDestinationPath, destPath)
            this.logger.debug('File successfully saved', { destPath })
            resolve()
          } catch (err) {
            this.logger.error(
              'Failed to move file from temp to final destination',
              { tempDestinationPath, destPath, error: err }
            )
            reject(
              new QvacErrorHyperdrive({
                code: ERR_CODES.DOWNLOAD_FAILED,
                adds: `Failed to finalize file: ${err.message}`,
                cause: err
              })
            )
          }
        })

        writeStream.on('error', err => {
          this.logger.error('Write stream error', { error: err })
          reject(
            new QvacErrorHyperdrive({
              code: ERR_CODES.DOWNLOAD_FAILED,
              adds: `Write error: ${err.message}`,
              cause: err
            })
          )
        })

        loaderStream.on('error', err => {
          this.logger.error('Loader stream error', { error: err })
          reject(
            new QvacErrorHyperdrive({
              code: ERR_CODES.DOWNLOAD_FAILED,
              adds: `Download error: ${err.message}`,
              cause: err
            })
          )
        })
      })

      try {
        if (this.progressReport) {
          this.progressReport.completeFile(fileName)
        }
      } catch (err) {
        this.logger.error('Progress reporter completion error', { error: err })
      }

      this.logger.info('File successfully saved to disk', {
        remotePath,
        destPath
      })
      return destPath
    } catch (err) {
      this.logger.error('saveFileToDisk failed', {
        remotePath,
        diskPath,
        error: err
      })

      if (err instanceof QvacErrorHyperdrive) {
        throw err
      }

      throw new QvacErrorHyperdrive({
        code: ERR_CODES.DOWNLOAD_FAILED,
        adds: `Save to disk failed: ${err.message}`,
        cause: err
      })
    }
  }

  async cancel () {
    this.logger.debug('cancel called', { file: this.file })
    this.download?.destroy()
  }

  async _downloadSingleFile (file) {
    this.logger.debug('_downloadSingleFile called', { file })
    const blobs = await this.drive.getBlobs()
    this.logger.debug('Retrieved blobs index')

    const entry = await this.drive.entry(file)

    this.logger.debug('Retrieved drive.entry', { file, entryExists: !!entry?.value?.blob })
    if (!entry?.value?.blob) {
      this.logger.error('File not found in drive', { file })
      throw new QvacErrorHyperdrive({ code: ERR_CODES.FILE_NOT_FOUND, adds: file })
    }

    const { blockOffset, blockLength, byteLength } = entry.value.blob
    const blockRange = [blockOffset, blockOffset + blockLength]
    const bytesPerBlock = byteLength / blockLength
    this.logger.debug('File blob metadata', { file, blockOffset, blockLength, byteLength, bytesPerBlock })

    this.logger.debug('Initiating download via drive.download', { file })
    this.download = this.drive.download(file)
    await this._monitorDownloadProgress(
      file,
      blobs,
      blockRange,
      bytesPerBlock
    )
    this.logger.debug('_downloadSingleFile complete', { file })
  }

  async _monitorDownloadProgress (
    file,
    blobs,
    blockRange,
    bytesPerBlock
  ) {
    this.logger.debug('Start monitoring download progress', {
      file,
      blockRange,
      intervalMs: this.progressReportInterval
    })

    let lastReportedBlocks = 0
    let progressInterval = null

    const checkProgress = async () => {
      const [start, end] = blockRange
      let downloadedBlocks = 0

      // Check each block individually
      for (let block = start; block < end; block++) {
        if (await blobs.core.has(block, block + 1)) {
          downloadedBlocks++
        }
      }

      const blocksChange = downloadedBlocks - lastReportedBlocks

      if (blocksChange > 0 && this.progressReport) {
        const bytesChange = blocksChange * bytesPerBlock
        this.logger.debug('Reporting progress update', {
          file,
          blocksChange,
          bytesChange
        })
        this.progressReport.update(file, bytesChange)
        lastReportedBlocks = downloadedBlocks
      }
    }

    try {
      progressInterval = setInterval(checkProgress, this.progressReportInterval)
      this.logger.debug('Set up progress interval', {
        intervalId: progressInterval
      })

      await this.download.done()
      this.logger.debug('Download promise resolved', { file })
    } catch (err) {
      this.logger.error('Error during download', { file, error: err })
      throw err
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval)
        this.logger.debug('Cleared progress interval', { file })
      }

      await checkProgress()
      this.logger.debug('Final progress check complete', { file })
    }
  }
}

module.exports = HyperdriveProgressTracker
