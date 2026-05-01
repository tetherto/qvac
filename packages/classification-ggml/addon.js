'use strict'

// Native JsLogger is a process-wide singleton (static uv_async_t in
// addon-cpp); install its JS callback once, switch sinks per instance.
let _loggerInstalled = false
let _activeLoggerSink = null

function _ensureLoggerInstalled (binding) {
  if (_loggerInstalled) return
  const levels = ['error', 'warn', 'info', 'debug']
  binding.setLogger((priority, message) => {
    const sink = _activeLoggerSink
    if (!sink) return
    const level = levels[priority] || 'info'
    if (typeof sink[level] === 'function') {
      try { sink[level](message) } catch (_) {}
    }
  })
  _loggerInstalled = true
}

function _setActiveLoggerSink (sink) { _activeLoggerSink = sink }
function _clearActiveLoggerSink (sink) {
  if (_activeLoggerSink === sink) _activeLoggerSink = null
}

/**
 * Normalize a raw native event to `Output` / `Error` / `LogMsg` /
 * `JobEnded`, or `null` to drop. Keyed on payload shape because the
 * upstream JobRunner emits the stats trailer with a raw RTTI event
 * name (no `JobEnded` substring), so an array → `Output` and a plain
 * object → terminal `JobEnded`.
 */
function mapAddonEvent (rawEvent, rawData, rawError) {
  if (typeof rawEvent === 'string') {
    if (rawEvent.includes('Error')) {
      return { type: 'Error', data: rawData, error: rawError }
    }
    if (rawEvent.includes('LogMsg')) {
      return { type: 'LogMsg', data: rawData, error: null }
    }
    if (rawEvent.includes('JobEnded')) {
      return { type: 'JobEnded', data: rawData, error: null }
    }
    if (rawEvent.includes('JobStarted')) {
      return null
    }
  }
  if (Array.isArray(rawData)) {
    return { type: 'Output', data: rawData, error: null }
  }
  if (rawData && typeof rawData === 'object') {
    return { type: 'JobEnded', data: rawData, error: null }
  }
  return { type: rawEvent, data: rawData, error: rawError }
}

/**
 * Thin JS↔native bridge owning one bare C++ instance handle. Lifecycle
 * lives in `index.js`, mirroring `LlamaInterface` / `LlmLlamacpp`.
 */
class ClassificationInterface {
  constructor (binding, configurationParams, outputCb, logger = null) {
    this._binding = binding
    this._handle = null
    this._logger = logger

    if (logger && typeof logger === 'object' && !configurationParams.__disableNativeLogger) {
      _ensureLoggerInstalled(binding)
      _setActiveLoggerSink(logger)
    }

    this._handle = this._binding.createInstance(this, configurationParams, outputCb)
  }

  async activate () {
    if (!this._handle) throw new Error('Classification addon is not initialized')
    this._binding.activate(this._handle)
  }

  async runJob (input) {
    if (!this._handle) throw new Error('Classification addon is not initialized')
    return this._binding.runJob(this._handle, input)
  }

  async cancel () {
    if (!this._handle) return
    await this._binding.cancel(this._handle)
  }

  async unload () {
    if (this._handle === null) return
    if (this._logger) _clearActiveLoggerSink(this._logger)
    try {
      this._binding.destroyInstance(this._handle)
    } finally {
      this._handle = null
    }
  }
}

module.exports = {
  ClassificationInterface,
  mapAddonEvent
}
