'use strict'

const QvacLogger = require('@qvac/logging')
const ReadyResource = require('ready-resource')

/**
 * Base class for dataloaders
 * @class BaseDL
 */
class BaseDL extends ReadyResource {
  /**
   * Creates an instance of BaseDL.
   * @constructor
   * @param {Object} opts Options for the dataloader
   */
  constructor (opts) {
    super()

    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      throw new Error('ERR_OPTS_INVALID')
    }

    this.opts = opts
    this.client = null
    this.logger = new QvacLogger(opts.logger)
  }

  /**
   * Start the dataloader (INTERNAL METHOD)
   * @returns {Promise<void>}
   */
  async _open () {
    // no-op
  }

  /**
   * Stop the dataloader (INTERNAL METHOD)
   * @returns {Promise<void>}
   */
  async _close () {
    // no-op
  }

  /**
   * List files in a directory
   * @param {string} [path='.'] Path to list
   * @returns {Promise<Array<any>>} List of files
   */
  async list (path = '.') {
    throw new Error('ERR_METHOD_NOT_IMPLEMENTED')
  }

  /**
   * Get a file as async iterable buffer stream
   * @param {string} path Path to the file
   * @returns {Promise<AsyncIterable<Buffer>>} File content
   */
  async getStream (path) {
    throw new Error('ERR_METHOD_NOT_IMPLEMENTED')
  }
}

module.exports = BaseDL
