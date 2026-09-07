'use strict'

// Pre-load @qvac/fabric so its shared .bare module (the ggml runtime) is
// registered with the bare runtime before our addon resolves its DT_NEEDED
// dependency qvac__fabric@0.bare.
require('@qvac/fabric')

module.exports = require.addon()
