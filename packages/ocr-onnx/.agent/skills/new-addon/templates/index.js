'use strict'

const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const path = require('bare-path')
const binding = require('./binding')
const { normalizeName } = require('./addon.js')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

/**
 * Hello-world inference addon, scaffolded with the canonical addon shape.
 *
 *   const addon = new {{DISPLAY_NAME}}({ files: { model: ['/abs/path/to/model'] } })
 *   await addon.load()
 *   const response = await addon.run({ name: 'world' })
 *   const { text } = await response.await()
 *   await addon.unload()
 *
 * Replace `_load()` and `_runInternal()` with real model loading + inference.
 * The shape (constructor signature, lifecycle methods, job composition) is
 * shared by every addon in the monorepo — keep it consistent.
 */
class {{DISPLAY_NAME}} {
  constructor ({ files, config = {}, logger = null, opts = {} } = {}) {
    if (!files || !Array.isArray(files.model) || files.model.length === 0) {
      throw new TypeError('files.model must be a non-empty array of absolute paths')
    }
    for (const [i, entry] of files.model.entries()) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new TypeError(`files.model[${i}] must be an absolute path string`)
      }
      if (!path.isAbsolute(entry)) {
        throw new TypeError(`files.model[${i}] must be an absolute path (got: ${entry})`)
      }
    }
    this._files = files.model
    this._config = config
    this.logger = new QvacLogger(logger)
    this.opts = opts
    this._job = createJobHandler({ cancel: () => {} })
    this._run = exclusiveRunQueue()
    this._hasActiveResponse = false
    this.state = { configLoaded: false }
  }

  async load () {
    return this._run(async () => {
      if (this.state.configLoaded) return
      await this._load()
      this.state.configLoaded = true
    })
  }

  async _load () {
    // Hello-world stub: no real model is opened. Replace with the actual model
    // load when wiring a real backend (see qvac-lib-infer-llamacpp-llm for a
    // reference implementation).
    this.logger.info('Hello-world addon loaded (stub).')
  }

  async run (input) {
    return this._run(() => this._runInternal(input))
  }

  async _runInternal (input) {
    if (!this.state.configLoaded) {
      throw new Error('Addon not initialized. Call load() first.')
    }
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const name = normalizeName(input?.name)

    this.logger.info('Starting hello-world inference')

    const response = this._job.start()
    this._hasActiveResponse = true

    let text
    try {
      text = binding.sayHello(name)
    } catch (err) {
      this._job.fail(err)
      throw err
    }

    const result = { text }
    this._job.output(result)
    this._job.end(this.opts.stats ? { runs: 1 } : null, result)

    const finalized = response.await().finally(() => { this._hasActiveResponse = false })
    finalized.catch((err) => {
      this.logger?.warn?.('Inference response rejected:', err?.message || err)
    })
    response.await = () => finalized

    return response
  }

  async pause () { /* no-op: synchronous backend has no in-flight cancel point */ }

  async cancel () { /* no-op: see pause() */ }

  async unload () {
    return this._run(async () => {
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this._hasActiveResponse = false
      this.state.configLoaded = false
    })
  }

  getState () { return this.state }
}

module.exports = {{DISPLAY_NAME}}
module.exports.{{DISPLAY_NAME}} = {{DISPLAY_NAME}}
module.exports.normalizeName = normalizeName
