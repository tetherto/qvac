// Lower-level native-binding entrypoint, mirroring the llamacpp addons'
// `addon.js`. The mobile test harness (qvac-test-addon-mobile) unconditionally
// generates a `backend/addon.js` shim that `require('<pkg>/addon.js')`, so this
// must resolve for parity with the other addon mobile integration tests.
module.exports = require('./binding')
