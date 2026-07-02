// Desktop entry point. The test body lives in test/integration/ so the same
// suite feeds both the desktop `bare test.js` run and the mobile Device Farm
// harness (which auto-generates test/mobile/integration.auto.cjs from
// test/integration/*.test.js). Keep this a thin re-export.
require('./test/integration/logger.test.js')
