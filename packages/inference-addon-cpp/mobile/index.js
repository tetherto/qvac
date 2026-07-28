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
