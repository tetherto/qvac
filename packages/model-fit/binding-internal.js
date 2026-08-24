// Private addon surface. Not listed in `exports`, so it is unreachable from
// outside the package — the process runner is its only consumer, and the raw
// load-config fitter it carries is not public API. Packaged (see `files`)
// because the runner requires it at spawn time.
module.exports = require.addon()
