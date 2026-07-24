const b4a = require('b4a')

// Host-side counterpart of runner/relay: spawn a child, pump its pipe over the sideband, report exit.
module.exports = function serveSpawner(control, spawn) {
  const children = new Map()

  const onSpawn = (msg) => {
    const { id, entry, args } = msg
    let child
    try {
      child = spawn(entry, args)
    } catch {
      control.send('stow-relay:exit', { id, code: -1 })
      return
    }
    children.set(id, child.ipc)

    const resume = () => child.ipc.resume?.()
    child.ipc.on('data', (chunk) => {
      const drained = control.send('stow-relay:data', { id, chunk: b4a.toString(chunk, 'base64') })
      if (drained && typeof drained.then === 'function') {
        child.ipc.pause?.()
        drained.then(resume, resume)
      }
    })

    // the exit frame must never overtake trailing data on the ordered sideband, so hold it
    // until the readable has drained (end/close) — not just until the process exit resolves
    let code = 0
    let exited = false
    let ended = false
    let done = false
    const finish = () => {
      if (done || !exited || !ended) return
      done = true
      children.delete(id)
      control.send('stow-relay:exit', { id, code })
    }
    const end = () => {
      ended = true
      finish()
    }
    child.ipc.on('end', end)
    child.ipc.on('close', end)
    child.exit.then((c) => {
      code = c ?? 0
      exited = true
      resume() // a paused/parked readable must flow to 'end' or its last frame strands
      finish()
    })
  }
  const onData = (msg) => {
    children.get(msg.id)?.write(b4a.from(msg.chunk, 'base64'))
  }
  const onStop = (msg) => {
    children.get(msg.id)?.destroy() // EOF → the child exits; never killed
  }

  control.on('stow-relay:spawn', onSpawn)
  control.on('stow-relay:data', onData)
  control.on('stow-relay:stop', onStop)

  return function () {
    control.off('stow-relay:spawn', onSpawn)
    control.off('stow-relay:data', onData)
    control.off('stow-relay:stop', onStop)
    for (const ipc of children.values()) ipc.destroy()
    children.clear()
  }
}
