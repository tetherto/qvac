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
    // `_pendingSettled` is a Promise that resolves the moment the native
    // output callback fires for the in-flight job, regardless of
    // success or failure. We track it separately from the user-facing
    // classify() Promise so that unload() can deterministically wait
    // for the native side to finish before tearing down resources,
    // without racing the underlying JobRunner / OutputCallbackJs uv_
    // resources (which are not safe to destroy mid-callback).
    this._pendingSettled = null
    this._pendingSettledResolve = null

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

  _markPendingSettled () {
    const resolve = this._pendingSettledResolve
    this._pending = null
    this._pendingSettled = null
    this._pendingSettledResolve = null
    if (resolve) resolve()
  }

  _outputCallback (self, event, data, error) {
    const pending = this._pending
    if (!pending) return

    if (typeof event === 'string' && event.includes('Error')) {
      this._markPendingSettled()
      const err = new Error(typeof error === 'string' ? error : 'Classification failed')
      if (error && typeof error === 'object' && error.message) err.message = error.message
      pending.reject(err)
      return
    }

    if (Array.isArray(data)) {
      this._markPendingSettled()
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

    this._pendingSettled = new Promise((resolve) => {
      this._pendingSettledResolve = resolve
    })

    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject }
      let accepted = false
      try {
        accepted = binding.runJob(this._handle, job)
      } catch (err) {
        this._markPendingSettled()
        reject(err)
        return
      }
      if (!accepted) {
        this._markPendingSettled()
        reject(new Error('Classification job was rejected by the native runner'))
      }
    })
  }

  /**
   * Tears down the native instance. Idempotent; safe to call repeatedly.
   *
   * Waits for any in-flight job's native callback to fire before calling
   * `binding.destroyInstance`. This is required for safety: the underlying
   * JobRunner uses a worker thread and OutputCallbackJs uses a uv_async
   * handle; tearing them down while a callback is still in flight races
   * the handle's close lifecycle and crashes (use-after-free observed
   * across linux-x64 / darwin-arm64 / android / ios in CI).
   */
  async unload () {
    if (this._handle === null) return

    // 1. Wait for any in-flight classify() call to settle naturally.
    //    The user-facing Promise returned by classify() will resolve
    //    or reject with whatever the native side produces; we only
    //    need to ensure the native callback has fired before we
    //    proceed to destroyInstance.
    if (this._pendingSettled) {
      try { await this._pendingSettled } catch (_) {}
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
