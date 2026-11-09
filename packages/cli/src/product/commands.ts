import { commands as chat } from './chat/commands.js'
import { commands as dashboard } from './dashboard/commands.js'

export interface ProductCommand {
  name: string
  desc: string
  alias?: string
  args?: string
}

export const commands: ProductCommand[] = [
  ...chat,
  { name: 'config', desc: 'Active configuration' },
  ...dashboard,
  { name: 'hotkeys', desc: 'Keys and commands' },
  { name: 'help', desc: 'Keys and commands' },
  { name: 'quit', desc: 'Exit QV.AC' }
]

export function match(input: string, extra: ProductCommand[] = []) {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\n')) {
    return []
  }

  const all = [...commands.filter((c) => !c.alias), ...extra]
  const [head = '', ...rest] = input.slice(1).split(' ')
  const query = head.toLowerCase()
  if (rest.length) {
    return all.filter((c) => c.name === query)
  }

  return [
    ...all.filter((c) => c.name.startsWith(query)),
    ...all.filter((c) => !c.name.startsWith(query) && query && c.desc.toLowerCase().includes(query))
  ]
}

export function parse(input: string) {
  const text = input.trim().slice(1),
    space = text.search(/\s/)
  return space < 0
    ? { name: text.toLowerCase(), arg: '' }
    : { name: text.slice(0, space).toLowerCase(), arg: text.slice(space).trim() }
}
