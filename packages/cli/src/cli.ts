import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { route } from './route.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

const HELP = `Usage: qvac <command> [options]

Commands:
  sdk <command>  QVAC SDK tools: OpenAI-compatible server, worker bundler, doctor,
                 configure and verify

Options:
  -V, --version  output the version number
  -h, --help     display help for command

Run 'qvac sdk --help' for the SDK commands.
`

export interface RunOptions {
  // The `qvac-sdk` binary to run. Defaults to the installed @qvac/sdk-tools.
  sdkToolsBin?: string
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<void> {
  const target = route(argv)

  switch (target.kind) {
    case 'help':
      ;(target.exitCode === 0 ? process.stdout : process.stderr).write(HELP)
      process.exitCode = target.exitCode
      return
    case 'version':
      process.stdout.write(`${pkg.version}\n`)
      return
    case 'error':
      fail(`${target.message}\n\nRun 'qvac --help' for the available commands.`)
      return
    case 'sdk': {
      if (target.deprecation) {
        const { used, replacement } = target.deprecation
        process.stderr.write(`warning: '${used}' is deprecated. Use '${replacement}' instead.\n`)
      }
      const bin = options.sdkToolsBin ?? resolveSdkToolsBin()
      if (bin === undefined) {
        fail('@qvac/sdk-tools is not installed. Reinstall @qvac/cli to restore it.')
        return
      }
      await runInProcess(bin, target.args)
    }
  }
}

export function resolveSdkToolsBin(): string | undefined {
  let manifestPath: string
  try {
    manifestPath = require.resolve('@qvac/sdk-tools/package.json')
  } catch {
    return undefined
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: Record<string, string>
  }
  const bin = manifest.bin?.['qvac-sdk']
  return bin === undefined ? undefined : resolve(dirname(manifestPath), bin)
}

// Loads the binary in this process with the argv it would get if started on its
// own, so signals, stdin and the exit code are exactly those of `qvac-sdk`. A
// child process would also receive the terminal's Ctrl+C, so forwarding it would
// deliver it twice, and `serve` skips its graceful shutdown on a second SIGINT.
async function runInProcess(bin: string, args: readonly string[]): Promise<void> {
  process.argv = [process.execPath, bin, ...args]
  await import(pathToFileURL(bin).href)
}

function fail(message: string): void {
  process.stderr.write(`error: ${message}\n`)
  process.exitCode = 1
}
