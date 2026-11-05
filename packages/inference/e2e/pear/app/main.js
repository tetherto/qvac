// On Bare, `PearRuntime.run()` starts the worker in an in-process thread.
// Worker lines are forwarded to stdout with a prefix the runner parses.

const PearRuntime = require('pear-runtime')

const ipc = PearRuntime.run(require.resolve('./worker.mjs'), Bare.argv.slice(2))

let pending = ''

ipc.on('data', (data) => {
  const lines = (pending + data).split('\n')
  pending = lines.pop()
  for (const line of lines) console.log('PEAR_E2E ' + line)
})
