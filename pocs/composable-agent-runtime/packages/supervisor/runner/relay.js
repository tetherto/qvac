const { Duplex } = require('bare-stream')
const b4a = require('b4a')
const { wrap } = require('bare-stow/host')

// Bare-side runner: a worklet cannot spawn, so it asks the host over the stow control sideband.
let seq = 0

module.exports = function relayRunner(control) {
  return function (entry, args) {
    const id = ++seq
    const relayed = new Duplex({
      write(chunk, encoding, cb) {
        const done = () => cb(null)
        const drained = control.send('stow-relay:data', {
          id,
          chunk: b4a.toString(chunk, 'base64')
        })
        if (drained && typeof drained.then === 'function') {
          drained.then(done, done)
        } else {
          done()
        }
      },
      destroy(err, cb) {
        control.send('stow-relay:stop', { id })
        cb(null)
      }
    })
    const onData = (msg) => {
      if (msg.id === id) relayed.push(b4a.from(msg.chunk, 'base64'))
    }
    let settle
    const exit = new Promise((resolve) => {
      settle = resolve
    })
    const onExit = (msg) => {
      if (msg.id !== id) return
      control.off('stow-relay:data', onData)
      control.off('stow-relay:exit', onExit)
      relayed.push(null)
      settle(msg.code)
    }
    control.on('stow-relay:data', onData)
    control.on('stow-relay:exit', onExit)
    control.send('stow-relay:spawn', { id, entry, args })
    return { ipc: wrap(relayed), exit }
  }
}
