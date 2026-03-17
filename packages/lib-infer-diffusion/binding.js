const binding = require.addon()
const proc = require('bare-process')

if (binding.notifyProcessExit) proc.on('exit', () => binding.notifyProcessExit())

module.exports = binding
