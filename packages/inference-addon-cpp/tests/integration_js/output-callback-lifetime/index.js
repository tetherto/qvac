const binding = require('./binding')

exports.createInstance = binding.createInstance
exports.runJob = binding.runJob
exports.blockEventLoop = binding.blockEventLoop
exports.destroyInstance = binding.destroyInstance
