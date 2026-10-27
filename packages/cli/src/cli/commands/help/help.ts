import type { ParsedCommand, LauncherKit } from '../../../lib/types.js'
import { tree } from '../../index.js'

// paparam writes the help from each command's own summary, flags and arguments
export function runHelp({ words }: ParsedCommand, { version, usage }: LauncherKit) {
  const root = tree({ version })
  const names = words.filter((word: string) => word !== 'host')
  let node = root
  for (const name of names) {
    const child = node._definedCommands.get(name)
    if (!child) {
      return usage(`no help for ${words.join(' ')}. Use qvac help.`)
    }
    node = child
  }

  console.log(root.help(...names))
}
