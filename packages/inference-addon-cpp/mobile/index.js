const binding = require('./binding')

// js-create-double-first-call
exports.createDouble = binding.createDouble
exports.createInt32 = binding.createInt32

// logger
exports.setLogger = binding.setLogger
exports.cppLog = binding.cppLog
exports.dummyCppLogWork = binding.dummyCppLogWork
exports.dummyMultiThreadedCppLogWork = binding.dummyMultiThreadedCppLogWork
exports.releaseLogger = binding.releaseLogger

// output-callback-lifetime
exports.createInstance = binding.createInstance
exports.createMultiInstance = binding.createMultiInstance
exports.runJob = binding.runJob
exports.cancelJob = binding.cancelJob
exports.onJsThread = binding.onJsThread
exports.blockEventLoop = binding.blockEventLoop
exports.destroyInstance = binding.destroyInstance
