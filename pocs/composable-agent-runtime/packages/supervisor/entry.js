/* global Bare */
const safetyCatch = require('safety-catch')

// Stow worker entry wrapper: owns EOF→stop→exit(0) and gave-up→exit(1) so a host declares only its tree.
module.exports = function stowEntry(build) {
  return async function (ipc, ready) {
    let stop = null
    const die = (code) => {
      // exit only after stop() unwinds — a still-loaded model wedges runtime teardown
      Promise.resolve(stop?.())
        .catch(safetyCatch)
        .finally(() => Bare.exit(code))
    }
    Bare.IPC.on('end', () => die(0)).on('close', () => die(0))
    const sup = await build(ipc)
    sup.on('gave-up', () => die(1))
    stop = () => sup.close() // assigned before ready so a host death mid-boot still tears down
    await sup.ready()
    ready()
    return stop
  }
}
