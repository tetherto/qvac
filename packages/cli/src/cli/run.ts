import type { RuntimeOptions } from '../lib/types.js'
import process from 'bare-process'
import { startCore, CommandError } from './core.js'
import { CommandIO } from './io.js'
import { statusFromServe } from './commands/status/status.js'
import { find } from './index.js'

// Runs one Core-backed command and answers its exit code; Core is closed on every path.
export async function runCommand(options: RuntimeOptions) {
  const stopping = new Promise<string>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => resolve(signal))
    }
  })
  const io = new CommandIO(process as unknown as ConstructorParameters<typeof CommandIO>[0], {
    ...options,
    tty: {
      stdin: 'isTTY' in process.stdin && !!process.stdin.isTTY,
      stdout: 'isTTY' in process.stdout && !!process.stdout.isTTY,
      stderr: 'isTTY' in process.stderr && !!process.stderr.isTTY
    },
    stopping
  })
  let host = null
  try {
    host = await startCore(options, io)
    const route = find(options.command, options.action)
    if (route.where !== 'core') throw new Error(`Invalid Core command: ${options.command}`)
    return await route.run(host, options, io)
  } catch (caught) {
    const error: Error & { locked?: boolean } =
      caught instanceof Error ? caught : new Error(String(caught))
    if (options.command === 'status' && error.locked) {
      const shown = statusFromServe(options, io)
      if (shown !== null) {
        return shown
      }

      error.message += ' qvac status can read beside a running qvac serve, not beside the chat app.'
    }

    io.redraw(null)
    process.stderr.write(`qvac: ${error.message}\n`)

    return error instanceof CommandError ? error.code : 1
  } finally {
    io.close()
    await host?.close()
  }
}
