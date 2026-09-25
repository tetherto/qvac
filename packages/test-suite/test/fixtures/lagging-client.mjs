// A client that answers in order but late: the first `execute` is delayed, so its reply lands
// after the framework has already moved on to the next test.
let queue = Promise.resolve()
let buffer = ''

process.stdout.write(JSON.stringify({ type: 'ready', protocol: 1 }) + '\n')

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i = buffer.indexOf('\n')
  while (i !== -1) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (line) handle(JSON.parse(line))
    i = buffer.indexOf('\n')
  }
})

function handle(message) {
  if (message.type === 'shutdown') {
    process.exit(0)
  }
  if (message.type !== 'execute') return
  const delay = message.testId === 'slow' ? 150 : 0
  queue = queue.then(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          process.stdout.write(
            JSON.stringify({
              type: 'result',
              id: message.id,
              passed: true,
              output: `answer for ${message.testId}`
            }) + '\n'
          )
          resolve()
        }, delay)
      })
  )
}
