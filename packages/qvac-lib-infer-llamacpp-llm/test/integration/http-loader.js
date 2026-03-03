'use strict'

const https = require('bare-https')
const BaseDL = require('@qvac/dl-base')

/**
 * A minimal HTTP/HTTPS loader that implements the BaseDL interface.
 * Fetches model files from a remote base URL, following redirects.
 */
class HttpDL extends BaseDL {
  constructor (opts) {
    super(opts)

    if (!opts || !opts.baseUrl) {
      throw new Error('HttpDL requires a baseUrl option')
    }

    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/'
    this._activeStreams = new Set()
  }

  /**
   * Return the Content-Length of a remote file via an HTTP HEAD request.
   * @param {string} filename
   * @returns {Promise<number>} byte size
   */
  async getFileSize (filename) {
    return this._request('HEAD', this.baseUrl + filename)
  }

  /**
   * Fetch a file by name and return it as a readable stream.
   * The stream is tracked so that close() can destroy it if needed.
   * @param {string} filename
   * @returns {Promise<NodeJS.ReadableStream>}
   */
  async getStream (filename) {
    const response = await this._request('GET', this.baseUrl + filename)
    this._activeStreams.add(response)
    const cleanup = () => this._activeStreams.delete(response)
    response.on('end', cleanup)
    response.on('close', cleanup)
    response.on('error', cleanup)
    return response
  }

  async _close () {
    for (const stream of this._activeStreams) {
      stream.destroy()
    }
    this._activeStreams.clear()
  }

  _request (method, url, maxRedirects = 10) {
    return new Promise((resolve, reject) => {
      if (maxRedirects === 0) return reject(new Error(`Too many redirects for ${url}`))

      const req = https.request(url, { method, agent: false }, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode)) {
          response.resume()
          let loc = response.headers.location
          if (loc && loc.startsWith('/')) {
            const parsed = new URL(url)
            loc = `${parsed.protocol}//${parsed.host}${loc}`
          }
          resolve(this._request(method, loc, maxRedirects - 1))
          return
        }

        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`HTTP ${response.statusCode} ${method} ${url}`))
          return
        }

        if (method === 'HEAD') {
          response.resume()
          resolve(parseInt(response.headers['content-length'] || '0', 10))
        } else {
          resolve(response)
        }
      })

      req.on('error', reject)
      req.end()
    })
  }

  async list () {
    throw new Error('HttpDL does not support list()')
  }
}

module.exports = HttpDL
