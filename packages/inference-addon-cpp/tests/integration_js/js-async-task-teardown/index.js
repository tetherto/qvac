const binding = require('./binding')

exports.resetGate = binding.resetGate
exports.startGatedTask = binding.startGatedTask
exports.startGatedValueTask = binding.startGatedValueTask
exports.releaseGate = binding.releaseGate
exports.taskStarted = binding.taskStarted
exports.taskFinished = binding.taskFinished
exports.startTimedTask = binding.startTimedTask
exports.startFailingTask = binding.startFailingTask
exports.startDoublingTask = binding.startDoublingTask
exports.startFailingValueTask = binding.startFailingValueTask
exports.startThrowingMarshalTask = binding.startThrowingMarshalTask
exports.startGatedTaskOn = binding.startGatedTaskOn
exports.startCountedTaskOn = binding.startCountedTaskOn
exports.startDoublingTaskOn = binding.startDoublingTaskOn
exports.countedPosted = binding.countedPosted
exports.countedRuns = binding.countedRuns
