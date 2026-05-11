'use strict'

const http = require('http')
const ReadyResource = require('ready-resource')

const DEFAULT_PORT = 9210
const DEFAULT_HOST = '127.0.0.1'

class MetricsServer extends ReadyResource {
  constructor (promRegister, opts = {}) {
    super()

    this._register = promRegister
    this._port = opts.port || DEFAULT_PORT
    this._host = opts.host || DEFAULT_HOST
    this._logger = opts.logger || console
    this._server = null
  }

  async _open () {
    this._server = http.createServer(async (req, res) => {
      if (req.url === '/metrics' && req.method === 'GET') {
        try {
          const metrics = await this._register.metrics()
          res.writeHead(200, { 'Content-Type': this._register.contentType })
          res.end(metrics)
        } catch (err) {
          this._logger.error({ err }, 'MetricsServer: failed to collect metrics')
          res.writeHead(500)
          res.end('Internal Server Error')
        }
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    })

    await new Promise((resolve, reject) => {
      this._server.listen(this._port, this._host, () => {
        this._logger.info({
          host: this._host,
          port: this._port
        }, 'MetricsServer: listening')
        resolve()
      })
      this._server.on('error', reject)
    })
  }

  async _close () {
    if (!this._server) return

    await new Promise((resolve) => {
      this._server.close(() => {
        this._logger.info('MetricsServer: closed')
        resolve()
      })
    })
    this._server = null
  }
}

module.exports = MetricsServer
