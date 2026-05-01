'use strict'

// The native JsLogger is a process-wide singleton with a static uv_async_t;
// releasing it while another instance is still live races with the async
// close and causes a crash across repeated load/unload cycles. We therefore
// install the JS logger callback exactly once per process, point it at a
// module-level dispatcher, and swap the active sink when classifiers come
// and go.
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
 * Normalize a raw native event into the canonical
 * `Output` / `Error` / `LogMsg` / `JobEnded` shape, or `null` to drop it.
 *
 * The native side emits events whose name is the demangled C++ RTTI of
 * the payload type. For this addon the JobRunner queue produces, in
 * order, exactly:
 *   1. `struct qvac_lib_infer_ggml_classification::ClassifyOutput`
 *      (payload: an Array of `{label, confidence}`)
 *   2. `class std::vector<std::pair<std::string, std::variant<double,int64>>>`
 *      (the RuntimeStats trailer marshalled by `JsRuntimeStatsOutputHandler`)
 * plus, on failure paths, `Error` / `LogMsg` -named events.
 *
 * There is no separate `JobEnded` dispatch — the stats trailer is the
 * terminal. We therefore key on payload shape: an array is an `Output`,
 * a non-array non-null object is the stats terminal we promote to
 * `JobEnded`. Name-based matching is kept as a defensive fallback for
 * any future event the upstream addon-cpp might add.
 *
 * @param {string} rawEvent
 * @param {*} rawData
 * @param {*} rawError
 * @returns {{ type: string, data: *, error: * } | null}
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
 * Thin JS↔native bridge for the GGML classification addon. Owns the bare
 * C++ instance handle for one `ImageClassifier` and forwards every output
 * event to the supplied callback. Lifecycle (job orchestration, response
 * fan-out, run-queue serialisation) lives in `index.js`, mirroring the
 * `LlamaInterface` / `LlmLlamacpp` split used by the LLM addon.
 */
class ClassificationInterface {
  /**
   * @param {Object} binding - native `./binding` module (or a stub for tests)
   * @param {Object} configurationParams - `{ path, config?, __disableNativeLogger? }`
   * @param {Function} outputCb - `(self, event, data, error) => void`
   * @param {Object} [logger] - optional logger sink for the native bridge
   */
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
