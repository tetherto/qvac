'use strict'

const binding = require('./binding')

// The native JsLogger is a process-wide singleton with a static uv_async_t;
// releasing it while another instance is still live races with the async
// close and causes a crash across repeated load/unload cycles. We therefore
// install the JS logger callback exactly once per process, point it at a
// module-level dispatcher, and swap the active sink when classifiers come
// and go. This mirrors how the underlying qvac-lib-inference-addon-cpp
// expects the logger to be used.
let _loggerInstalled = false
let _activeLoggerSink = null

function _ensureLoggerInstalled () {
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

/**
 * Thin JS ↔ native bridge for the GGML classification addon. Keeps the
 * Bare-native handle alive for the lifetime of one `ImageClassifier` and
 * exposes a Promise-based `classify()` that resolves when the output
 * callback fires.
 */
class ClassificationInterface {
  /**
   * @param {Object} configurationParams - native configuration
   * @param {string} configurationParams.path - absolute path to the GGUF file
   * @param {Object} [configurationParams.config] - optional tunables (e.g. `threads`)
   * @param {Object} [logger] - @qvac/logging-compatible sink (optional)
   */
  constructor (configurationParams, logger = null) {
    this._handle = null
    this._logger = logger
    this._pending = null

    if (logger && typeof logger === 'object' && !configurationParams.__disableNativeLogger) {
      _ensureLoggerInstalled()
      _activeLoggerSink = logger
    }

    this._handle = binding.createInstance(
      this,
      configurationParams,
      this._outputCallback.bind(this)
    )
  }

  _outputCallback (self, event, data, error) {
    const pending = this._pending
    if (!pending) return

    if (typeof event === 'string' && event.includes('Error')) {
      this._pending = null
      const err = new Error(typeof error === 'string' ? error : 'Classification failed')
      if (error && typeof error === 'object' && error.message) err.message = error.message
      pending.reject(err)
      return
    }

    if (Array.isArray(data)) {
      this._pending = null
      pending.resolve(data)
    }
  }

  /**
   * Puts the addon into the ready-for-inference state. Called after
   * `createInstance` and any `loadWeights` streaming; a no-op for bundled
   * weight files, but kept for parity with other QVAC addons.
   */
  async activate () {
    if (!this._handle) throw new Error('Classification addon is not initialized')
    binding.activate(this._handle)
  }

  /**
   * Runs one classification job. Rejects if a previous call is still in
   * flight (the native JobRunner enforces this invariant as well).
   * @param {Object} job - `{ type: 'image', content: Uint8Array, width?, height?, channels?, topK? }`
   * @returns {Promise<Array<{label: string, confidence: number}>>}
   */
  async classify (job) {
    if (!this._handle) throw new Error('Classification addon is not initialized')
    if (this._pending) throw new Error('A classification is already in progress')

    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject }
      let accepted = false
      try {
        accepted = binding.runJob(this._handle, job)
      } catch (err) {
        this._pending = null
        reject(err)
        return
      }
      if (!accepted) {
        this._pending = null
        reject(new Error('Classification job was rejected by the native runner'))
      }
    })
  }

  /**
   * Tears down the native instance. Idempotent; safe to call repeatedly.
   */
  async unload () {
    if (this._handle === null) return

    if (this._pending) {
      try { this._pending.reject(new Error('Classifier unloaded during inference')) } catch (_) {}
      this._pending = null
    }

    // Intentionally do NOT call binding.releaseLogger() here: the logger is
    // shared process-wide by design. We only detach the active sink, so any
    // in-flight log messages from other live classifiers continue to work.
    if (this._logger && _activeLoggerSink === this._logger) {
      _activeLoggerSink = null
    }

    try {
      binding.destroyInstance(this._handle)
    } finally {
      this._handle = null
    }
  }
}

module.exports = { ClassificationInterface }
