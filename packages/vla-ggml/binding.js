// Pre-load @qvac/fabric so its shared .bare module (the llama.cpp + ggml
// runtime) is registered with the bare runtime before our addon triggers
// resolution of its DT_NEEDED dependency qvac__fabric@0.bare.
require('@qvac/fabric')

module.exports = require.addon()
