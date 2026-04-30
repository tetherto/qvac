'use strict'

const https = require('bare-https')

/**
 * Minimal HTTP/HTTPS streamer used by the sharded-model integration test
 * to download a small public sharded GGUF before constructing the addon.
 *
 * Standalone — does not extend any base loader class. The package no
 * longer depends on `@qvac/dl-base` after the loader-removal refactor;
 * this helper exists solely so the sharded model-loading test can fetch
 * shard files without pulling a heavyweight loader implementation back
 * into devDependencies.
 *
 * Only the surface used by `model-loading.test.js` is implemented:
 *   - `new HttpDL({ baseUrl })`
 *   - `getStream(filename)` — returns a Bare-https response stream that
 *     can be piped into `fs.createWriteStream`.
 *   - `close()` — destroys any in-flight streams the caller did not
 *     consume to completion.
 */
class HttpDL {
  constructor (opts) {
    if (!opts || !opts.baseUrl) {
      throw new Error('HttpDL requires a baseUrl option')
    }

    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/'
    this._activeStreams = new Set()
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

  /**
   * Destroy any tracked streams that have not finished on their own.
   */
  async close () {
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

        resolve(response)
      })

      req.on('error', reject)
      req.end()
    })
  }
}

module.exports = HttpDL
