const binding = require('./binding')

exports.createInstance = binding.createInstance
exports.createStatsInstance = binding.createStatsInstance
exports.createMultiInstance = binding.createMultiInstance
exports.runJob = binding.runJob
exports.cancelJob = binding.cancelJob
exports.onJsThread = binding.onJsThread
exports.blockEventLoop = binding.blockEventLoop
exports.destroyInstance = binding.destroyInstance
