'use strict'

const InferenceManager = require('@tetherto/qvac-lib-manager-inference')

let inferenceManager = null

/**
 * Initializes and returns a singleton InferenceManager instance.
 * @returns {InferenceManager}
 */
const getInferenceManager = () => {
  if (inferenceManager) return inferenceManager

  inferenceManager = new InferenceManager()
  return inferenceManager
}

module.exports = {
  getInferenceManager
}
