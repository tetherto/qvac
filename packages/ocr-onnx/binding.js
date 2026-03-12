// Pre-load @qvac/onnx so its .bare module is registered with the bare runtime
// before our addon triggers Windows delay-load resolution of qvac__onnx@0.bare
// (bare_module_find requires modules to be already loaded).
require('@qvac/onnx')

module.exports = require.addon()
