const binding = require('./binding.js')

/**
 * ONNX Session wrapper
 * Provides a JS interface for creating and managing ONNX Runtime sessions
 */
class OnnxSession {
  /**
   * Create a new ONNX session
   * @param {string} modelPath - Path to the ONNX model file
   * @param {Object} [config] - Session configuration
   * @param {string} [config.provider='auto_gpu'] - Execution provider: 'cpu', 'auto_gpu', 'nnapi', 'coreml', 'directml'
   * @param {string} [config.optimization='extended'] - Graph optimization level: 'disable', 'basic', 'extended', 'all'
   * @param {number} [config.intraOpThreads=0] - Number of threads for intra-op parallelism (0 = auto)
   * @param {number} [config.interOpThreads=0] - Number of threads for inter-op parallelism (0 = auto)
   */
  constructor (modelPath, config = {}) {
    this._handle = binding.createSession(modelPath, config)
  }

  /**
   * Get information about model inputs
   * @returns {Array<{name: string, shape: number[], type: string}>}
   */
  getInputInfo () {
    return binding.getInputInfo(this._handle)
  }

  /**
   * Get information about model outputs
   * @returns {Array<{name: string, shape: number[], type: string}>}
   */
  getOutputInfo () {
    return binding.getOutputInfo(this._handle)
  }

  /**
   * Run inference
   * @param {Array<{name: string, shape: number[], type: string, data: TypedArray}>} inputs
   * @returns {Array<{name: string, shape: number[], type: string, data: TypedArray}>}
   */
  run (inputs) {
    return binding.run(this._handle, inputs)
  }

  /**
   * Get the native handle for passing to other addons
   * @returns {external} Native session handle
   */
  get nativeHandle () {
    return this._handle
  }

  /**
   * Dispose of the session and free resources
   */
  dispose () {
    if (this._handle) {
      binding.destroySession(this._handle)
      this._handle = null
    }
  }
}

/**
 * Create a new ONNX session (convenience function)
 * @param {string} modelPath - Path to the ONNX model file
 * @param {Object} [config] - Session configuration
 * @returns {external} Native session handle for passing to other addons
 */
function createSession (modelPath, config = {}) {
  return binding.createSession(modelPath, config)
}

/**
 * Destroy an ONNX session
 * @param {external} handle - Native session handle
 */
function destroySession (handle) {
  binding.destroySession(handle)
}

/**
 * Get input tensor info from a session
 * @param {external} handle - Native session handle
 * @returns {Array<{name: string, shape: number[], type: string}>}
 */
function getInputInfo (handle) {
  return binding.getInputInfo(handle)
}

/**
 * Get output tensor info from a session
 * @param {external} handle - Native session handle
 * @returns {Array<{name: string, shape: number[], type: string}>}
 */
function getOutputInfo (handle) {
  return binding.getOutputInfo(handle)
}

/**
 * Run inference on a session
 * @param {external} handle - Native session handle
 * @param {Array<{name: string, shape: number[], type: string, data: TypedArray}>} inputs
 * @returns {Array<{name: string, shape: number[], type: string, data: TypedArray}>}
 */
function run (handle, inputs) {
  return binding.run(handle, inputs)
}

/**
 * Get cache statistics
 * Sessions are cached by model path + config to enable sharing across addons
 * @returns {{sessionCount: number, sessions: Array<{key: string, modelPath: string, refCount: number}>}}
 */
function getCacheStats () {
  return binding.getCacheStats()
}

module.exports = {
  OnnxSession,
  createSession,
  destroySession,
  getInputInfo,
  getOutputInfo,
  run,
  getCacheStats
}
