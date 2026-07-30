const binding = require('./binding')

exports.resetGate = binding.resetGate
exports.startGatedTask = binding.startGatedTask
exports.releaseGate = binding.releaseGate
exports.taskStarted = binding.taskStarted
exports.taskFinished = binding.taskFinished
exports.startTimedTask = binding.startTimedTask
exports.startFailingTask = binding.startFailingTask
