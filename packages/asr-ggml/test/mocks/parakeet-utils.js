'use strict'

// The parakeet suite's mock helpers turned out identical to the whisper ones
// after the merge, so this is a plain alias: `{ wait, transitionCb }`. Kept as
// a file (rather than deleted) so parakeet-prefixed tests and any external
// snippets that import it keep working.
module.exports = require('./utils.js')
