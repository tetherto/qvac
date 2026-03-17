const binding = require.addon()
const proc = require('bare-process')
if (binding.forceExit) proc.on('exit', (code) => binding.forceExit(code))
module.exports = binding
