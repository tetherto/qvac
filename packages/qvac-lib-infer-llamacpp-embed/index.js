'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue } = require('@qvac/infer-base')
const { BertInterface } = require('./addon')

const RUN_BUSY_ERROR_MESSAGE = 'Cannot set new job: a job is already set or being processed'

class GGMLBert {
  constructor ({ files, config = {}, logger = null, opts = {} }) {
    this._files = files.model
    this._config = config
    this.logger = new QvacLogger(logger)
    this.opts = opts
    this._job = createJobHandler({ cancel: () => this.addon.cancel() })
    this._run = exclusiveRunQueue()
    this.addon = null
    this._hasActiveResponse = false
    this.state = { configLoaded: false }
  }

  async load () {
    if (this.state.configLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }
    await this._load()
    this.state.configLoaded = true
  }

  async _load () {
    this.logger.info('Starting model load')
    const configurationParams = {
      path: this._files[this._files.length - 1],
      config: this._config
    }
    this.addon = this._createAddon(configurationParams)

    if (this._files.length > 1) {
      await this._streamShards()
    }

    await this.addon.activate()
    this.logger.info('Model load completed successfully')
  }

  async _streamShards () {
    for (const filePath of this._files) {
      const filename = path.basename(filePath)
      const stream = fs.createReadStream(filePath)
      for await (const chunk of stream) {
        await this.addon.loadWeights({ filename, chunk, completed: false })
      }
      await this.addon.loadWeights({ filename, chunk: null, completed: true })
      this.logger.info(`Streamed weights for ${filename}`)
    }
  }

  async run (input) {
    return this._run(() => this._runInternal(input))
  }

  async _runInternal (text) {
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    this.logger.info('Starting inference embeddings for text:', text)
    const inputData = Array.isArray(text)
      ? { type: 'sequences', input: text }
      : { type: 'text', input: text }

    const response = this._job.start()

    let accepted
    try {
      accepted = await this.addon.runJob(inputData)
    } catch (error) {
      this._job.fail(error)
      throw error
    }
    if (!accepted) {
      this._job.fail(new Error(RUN_BUSY_ERROR_MESSAGE))
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    this._hasActiveResponse = true
    const finalized = response.await().finally(() => { this._hasActiveResponse = false })
    finalized.catch(() => {})
    response.await = () => finalized
    return response
  }

  _addonOutputCallback (addon, event, data, error) {
    const isStatsData = typeof data === 'object' && data !== null && (
      'tokens_per_second' in data ||
      ('total_tokens' in data || 'total_time_ms' in data || 'batch_size' in data || 'context_size' in data)
    )
    if (isStatsData) {
      const runtimeStats = { ...data }
      if (runtimeStats.backendDevice === 0) {
        runtimeStats.backendDevice = 'cpu'
      } else if (runtimeStats.backendDevice === 1) {
        runtimeStats.backendDevice = 'gpu'
      }
      this._job.end(this.opts.stats ? runtimeStats : null)
      return
    }

    if (event.includes('Error')) {
      this.logger.error(`Job failed with error: ${error}`)
      this._job.fail(error)
    } else if (event.includes('Embeddings')) {
      this._job.output(data)
    } else {
      this._job.output(data)
    }
  }

  _createAddon (configurationParams) {
    const binding = require('./binding')
    return new BertInterface(
      binding,
      configurationParams,
      this._addonOutputCallback.bind(this)
    )
  }

  async unload () {
    return this._run(async () => {
      await this.cancel()
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this._hasActiveResponse = false
      if (this.addon) {
        await this.addon.unload()
      }
      this.state.configLoaded = false
    })
  }

  async cancel () {
    if (this.addon) {
      await this.addon.cancel()
    }
  }

  getState () { return this.state }
}

module.exports = GGMLBert
