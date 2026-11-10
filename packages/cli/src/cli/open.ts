import type { ParsedCommand, LauncherKit } from '../lib/types.js'
import process from '#process'

// qvac alone: the dashboard, which needs a terminal
export async function runOpen({ words, options }: ParsedCommand, { app, usage }: LauncherKit) {
  if (words.length) {
    usage(`unexpected "${words.join(' ')}". Use qvac --help.`)
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    usage('QVAC needs a terminal. Use qvac serve for an unattended host, or --help.')
  }

  await app(options)
}
