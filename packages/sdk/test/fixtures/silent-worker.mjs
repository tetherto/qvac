// Bare worker that starts but never signals ready, so the client's startup
// timer is the only thing that can end the wait. Used to prove the timeout is
// configurable without waiting out the default.

export default function start() {
  return new Promise(() => {})
}
