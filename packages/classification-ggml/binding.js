// Pre-load @qvac/fabric so its shared .bare module (the llama.cpp + ggml
// runtime) is registered with the bare runtime before our addon triggers
// resolution of its DT_NEEDED dependency qvac__fabric-<host>@0.bare (shipped by @qvac/fabric-<host>).
require('@qvac/fabric')

module.exports = require.addon()
