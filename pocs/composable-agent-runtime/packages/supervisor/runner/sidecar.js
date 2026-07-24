const Sidecar = require('bare-sidecar')
const { wrap } = require('bare-stow/host')

// the reference Port runner: the stow bundle in its own OS process (bare-sidecar)
module.exports = function launch(entry, args, logger) {
  const child = new Sidecar(entry, args)
  // stdout/stderr stay drained even with no logger — an unread pipe blocks a chatty child
  child.stdout.on('data', (data) => logger?.info('stow', data.toString().trimEnd()))
  child.stderr.on('data', (data) => logger?.warn('stow', data.toString().trimEnd()))
  const ipc = wrap(child)
  const exit = new Promise((resolve) => child.once('exit', resolve))
  return { ipc, exit }
}
