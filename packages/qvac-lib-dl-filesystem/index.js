'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const BaseDL = require('@qvac/dl-base')
const { QvacErrorFilesystem, ERR_CODES } = require('./src/lib/error')

/**
 * @typedef {Object} FilesystemDLOptions
 * @property {string} dirPath - The base directory path.
 */

/**
 * FilesystemDL class for handling file system download logic.
 * @extends {BaseDL}
 */
class FilesystemDL extends BaseDL {
  /**
   * @param {FilesystemDLOptions} opts - Options object with directory path.
   */
  constructor (opts) {
    super(opts)
    this.logger.debug('FilesystemDL constructor called', { opts })

    if (!opts || !('dirPath' in opts)) {
      this.logger.error('Invalid options provided', { opts })
      throw new QvacErrorFilesystem({ code: ERR_CODES.OPTS_INVALID })
    }

    if (!fs.existsSync(opts.dirPath)) {
      this.logger.error('Directory does not exist', { dirPath: opts.dirPath })
      throw new QvacErrorFilesystem({ code: ERR_CODES.PATH_INVALID, adds: opts.dirPath })
    }

    this.logger.debug('FilesystemDL initialized successfully', { dirPath: opts.dirPath })
  }

  /**
   * Get a file as async iterable buffer stream.
   * @param {string} filePath - The relative path to the file.
   * @returns {Promise<AsyncIterable<Buffer>>} The file content as async iterable.
   */
  async getStream (filePath) {
    this.logger.debug('getStream called', { filePath })
    const fullPath = path.join(this.opts.dirPath, filePath)
    this.logger.debug('Resolved full path for stream', { fullPath })

    if (!fs.existsSync(fullPath)) {
      throw new QvacErrorFilesystem({ code: ERR_CODES.FILE_NOT_FOUND, adds: fullPath })
    }

    if (!fs.statSync(fullPath).isFile()) {
      this.logger.error('File not found for streaming', { fullPath })
      throw new QvacErrorFilesystem({ code: ERR_CODES.PATH_INVALID, adds: fullPath })
    }

    this.logger.debug('Creating read stream', { fullPath })
    return fs.createReadStream(fullPath)
  }

  /**
   * List the files in the directory.
   * @param {string} [directoryPath='.'] - The directory to list files from.
   * @returns {Promise<string[]>} Array of file names in the directory.
   */
  async list (directoryPath = '.') {
    this.logger.debug('list called', { directoryPath })
    const fullPath = path.join(this.opts.dirPath, directoryPath)
    this.logger.debug('Resolved full path for list', { fullPath })

    if (!fs.existsSync(fullPath)) {
      this.logger.error('Directory not found for listing', { fullPath })
      throw new QvacErrorFilesystem({ code: ERR_CODES.DIR_NOT_FOUND, adds: fullPath })
    }

    if (!fs.statSync(fullPath).isDirectory()) {
      this.logger.error('Path is not a directory for listing', { fullPath })
      throw new QvacErrorFilesystem({ code: ERR_CODES.PATH_INVALID, adds: fullPath })
    }

    const files = fs.readdirSync(fullPath)
    this.logger.debug('Directory listing successful', { fullPath, count: files.length })
    return files
  }
}

module.exports = FilesystemDL
