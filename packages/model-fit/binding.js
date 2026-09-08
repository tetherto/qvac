// `./binding.js` is a public export (see `exports` in package.json), so
// everything re-exported here is in-process public API. `llamaConfigFit` is
// deliberately absent: raw load-parameter normalization stays private to the
// disposable process runner, which reaches the addon through
// `./binding-internal.js`. Keeping this an explicit list rather than a blanket
// re-export means a new native export cannot become public by accident.
// Pre-load Fabric so its shared llama.cpp + ggml bare module is registered
// before this addon resolves its DT_NEEDED dependency (notably on Windows).
require('@qvac/fabric')

const addon = require.addon()

module.exports = { paramsFit: addon.paramsFit }
