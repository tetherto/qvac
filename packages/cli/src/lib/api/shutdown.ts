import goodbye from 'graceful-goodbye'

const signals: NodeJS.Signals[] = [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGSEGV',
  'SIGUSR2',
  'SIGTERM'
]

// graceful-goodbye owns normal-exit cleanup. Preserve the server's successful
// signal exits, fatal-error handling, and bounded shutdown around that lifecycle.
export function installShutdown(close: (signal?: NodeJS.Signals) => Promise<void>): void {
  let closing = false
  let signal: NodeJS.Signals | undefined
  let failed = false

  goodbye(async () => {
    closing = true
    const deadline = setTimeout(() => {
      console.error('killed by timeout (10000ms)')
      process.exit(1)
    }, 10_000)
    try {
      await close(signal)
    } catch (error) {
      console.error(error)
      failed = true
    } finally {
      clearTimeout(deadline)
    }
    process.exit(failed ? 1 : 0)
  })

  for (const name of signals) {
    process.prependListener(name, () => {
      if (closing) {
        console.error(`second ${name}, exiting`)
        process.exit(1)
      }
      signal = name
      // SIGINT/SIGTERM already dispatch through graceful-goodbye's listener.
      if (name !== 'SIGINT' && name !== 'SIGTERM') goodbye.exit()
    })
  }
  const onError = (error: unknown) => {
    console.error(error)
    if (closing) process.exit(1)
    failed = true
    goodbye.exit()
  }
  process.on('uncaughtException', onError)
  process.on('unhandledRejection', onError)
}
