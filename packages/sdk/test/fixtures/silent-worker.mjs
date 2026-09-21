// Bare worker that starts cleanly but never opens the IPC connection, so the
// client's initialization timer is the only thing that can end the wait.
// Used to prove the timeout is configurable without waiting out the default.

import Signal from 'bare-signals'

const signals = new Signal.Emitter()
signals.once('SIGTERM', () => Bare.exit(0))

setInterval(() => {}, 1_000)
