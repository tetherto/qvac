const binding = require('./binding')

exports.setLogger = binding.setLogger
exports.cppLog = binding.cppLog
exports.dummyCppLogWork = binding.dummyCppLogWork
exports.dummyMultiThreadedCppLogWork = binding.dummyMultiThreadedCppLogWork
exports.releaseLogger = binding.releaseLogger

