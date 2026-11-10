import type { LauncherKit, ParsedCommand } from '../lib/types.js'
import { tree } from './index.js'

// paparam writes the help from the command's own summary, flags and argument
export function runHelp(_parsed: ParsedCommand, { version }: LauncherKit) {
  console.log(tree({ version }).help())
}
