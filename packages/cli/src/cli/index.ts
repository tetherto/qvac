import type { Command, Bail } from 'paparam'
import type { RoutedCommand } from './commands/command.js'
import type { LaunchOptions, ParsedCommand } from '../lib/types.js'
type ParseFailure = Error & { bail?: Bail; at?: Command }
interface TreeResult {
  leaf?: Command | undefined
  path: string[]
  words: string[]
  options: LaunchOptions
}
// The one place paparam is set up, for both launchers and the app: commands, flags, env and help.
import { bail, command as define, footer, header, summary } from 'paparam'
import { chat } from './commands/chat/index.js'
import { config } from './commands/config/index.js'
import { help } from './commands/help/index.js'
import { host } from './commands/host/index.js'
import { invite } from './commands/invite/index.js'
import { logs } from './commands/logs/index.js'
import { models } from './commands/models/index.js'
import { sdk } from './commands/sdk/index.js'
import { sdkArguments } from './commands/sdk/arguments.js'
import { serve } from './commands/serve/index.js'
import { status } from './commands/status/index.js'
import { workspace } from './commands/workspace/index.js'
import { CHAT, DEVICE, FLAGS, envName, flags, paramKey } from './flags.js'

const COMMANDS = [serve, invite, workspace, models, status, logs, config, chat, help, host, sdk]
// Asking for help or the version is never ambient, so neither reads an env var.
const NO_ENV = new Set(['version'])
const FALSE = new Set(['', '0', 'false', 'no', 'off'])
const HELP = new Set(['--help', '-h'])

export class UsageError extends Error {
  code: number
  constructor(message: string | undefined) {
    super(message)
    this.code = 2
  }
}

// commands keep what they parsed, so every parse builds its own tree
export function tree({ version = '' } = {}) {
  return define(
    'qvac',
    header(`QV.AC ${version}`.trimEnd() + ' — your most powerful device, everywhere.'),
    summary(
      'Open chat, setting this device up on first use. A first word that is not a command is your first message.'
    ),
    ...flags([...DEVICE, ...CHAT, 'version']),
    ...COMMANDS.map((make) => make()),
    footer(
      'Every flag also reads QVAC_<FLAG_NAME>, e.g. QVAC_DATA_DIR. qvac help <command> for one.'
    ),
    bail(rethrow)
  )
}

// { command, action, words, options, where }: what the launcher runs, or hands to the app
export function parseArgs(
  argv: string[],
  { env = {} }: { env?: Record<string, string | undefined> } = {}
): ParsedCommand {
  const sdkWords = sdkArguments(argv)
  if (sdkWords) {
    return parsed(['sdk'], { words: sdkWords, where: 'launcher' })
  }

  // everything after `--` is words, and after a leading one a chat message, even a command word
  const literal = argv.indexOf('--')
  const head = literal === -1 ? argv : argv.slice(0, literal)
  const tail = literal === -1 ? [] : argv.slice(literal + 1)
  const asked = head.some((word: string) => HELP.has(word))
  const read = asked ? helpPath(head) : parse(head)
  const options = { ...readEnv(env), ...read.options }
  if ('NO_COLOR' in env) {
    options.noColor ??= true
  }

  if (options.tail !== undefined) {
    options.tail = count(options.tail)
  }

  const path = literal !== -1 && read.path.length === 0 ? [] : read.path
  const words = [...read.words, ...tail]
  if (asked) {
    return parsed(['help'], { words: path, options, where: 'launcher' })
  }

  if (options.version) {
    return parsed(['version'], { options, where: 'launcher' })
  }

  return routed({ path, words, options, leaf: read.leaf })
}

// The runner a command path names, for the app that runs a Core command the launcher parsed.
export function find(command: string, action?: string | null) {
  const names = [command, action].filter((name): name is string => !!name)
  let node: Command = tree()
  // chat's `open` is how it was asked for, not a command below it
  for (const name of names) {
    node = node._definedCommands.get(name) ?? node
  }

  return (node as RoutedCommand).qvac
}

// help asked for shows the command it names, even one missing its argument
function helpPath(head: string[]): TreeResult {
  try {
    return parse(head.filter((word: string) => !HELP.has(word)))
  } catch (caught) {
    const error = caught as ParseFailure
    if (!error.at) {
      throw error
    }

    return { path: pathOf(error.at), words: [], options: {} }
  }
}

function parse(argv: string[]): TreeResult {
  let leaf
  try {
    leaf = tree().parse(argv, { sync: true, silent: true, run: false })
  } catch (caught) {
    const error = caught as ParseFailure
    if (!error.bail) throw error
    if (error.bail.reason !== 'UNKNOWN_ARG' || error.bail.command.parent) {
      throw Object.assign(usageError(error.bail!, argv), { at: error.bail?.command })
    }

    // a first word that names no command starts a chat message
    leaf = chat('qvac').add(bail(rethrow)).parse(argv, { sync: true, silent: true, run: false })
  }

  return { leaf: leaf!, path: pathOf(leaf), words: leaf!.positionals, options: optionsOf(leaf) }
}

function routed({ path, words, options, leaf }: TreeResult): ParsedCommand {
  if (path.length === 0) {
    return parsed(['chat'], { words, options, where: 'app' })
  }

  // a group alone names no command: qvac workspace
  if (!leaf || !(leaf as RoutedCommand).qvac.where) {
    throw new UsageError(takes(leaf!))
  }

  const [first, ...rest] = path[0] === 'host' ? path.slice(1) : path
  const command = first === 'chat' ? ['chat', 'open'] : [first, ...rest]

  return parsed(command, { words, options, where: (leaf as RoutedCommand).qvac.where! })
}

const parsed = (
  [command = 'chat', action = null]: Array<string | null | undefined>,
  {
    words = [],
    options = {},
    where
  }: { words?: string[]; options?: LaunchOptions; where: ParsedCommand['where'] }
): ParsedCommand => ({
  command: command!,
  action,
  words,
  options,
  where
})

function pathOf(leaf: Command | null) {
  const path = []
  for (let c = leaf; c?.parent; c = c.parent) {
    path.unshift(c.name)
  }

  return path.filter((name) => name !== 'qvac')
}

// flags from every level of the path, the deepest given one winning
function optionsOf(leaf: Command | null) {
  const options: Record<string, string | boolean | undefined> = {}
  for (let c = leaf; c; c = c.parent) {
    for (const f of FLAGS) {
      const name = paramKey(f)
      if (f.key in options || !(name in c.indices.flags)) {
        continue
      }

      options[f.key] = f.name.startsWith('no-')
        ? !c.flags[name]
        : (c.flags[name] as string | boolean | undefined)
    }
  }

  return options as LaunchOptions
}

export function readEnv(env: Record<string, string | undefined>): LaunchOptions {
  const options: Record<string, string | boolean | undefined> = {}
  for (const f of FLAGS) {
    const value = env[envName(f)]
    if (value === undefined || NO_ENV.has(f.name) || f.key in options) {
      continue
    }

    options[f.key] = f.value ? value : !FALSE.has(value.trim().toLowerCase())
  }

  return options as LaunchOptions
}

function count(value: string | number) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`--tail takes a whole number of lines, not ${value}`)
  }

  return n
}

function rethrow(reason: Bail): never {
  throw Object.assign(new Error(reason.reason), { bail: reason })
}

function usageError({ reason, flag, arg, command: at }: Bail, argv: string[]) {
  const given = flag && (flag.long ? '--' : '-') + flag.name
  // as typed, so `--=x` reads as itself
  const name = argv.find((word: string) => word === given || word.startsWith(given + '=')) || given
  if (reason === 'UNKNOWN_FLAG') {
    return new UsageError(`unknown option ${name}. Use qvac --help.`)
  }

  if (reason === 'INVALID_FLAG') {
    return new UsageError(flag?.value ? `${name} takes no value` : `missing value for ${name}`)
  }

  const usage = ['qvac', ...pathOf(at), ...at._definedArgs.map((a) => a.help)].join(' ')
  if (reason === 'MISSING_ARG') {
    return new UsageError(`missing ${arg?.value}: ${usage}`)
  }

  if (at._definedCommands.size > 0) {
    return new UsageError(takes(at))
  }

  return new UsageError(`unexpected "${arg?.value}": ${usage}`)
}

function takes(group: Command) {
  const names = [...group._definedCommands.keys()]
  const [name] = pathOf(group)

  return name === 'host'
    ? 'host takes one command: serve (or just qvac serve).'
    : `${name} takes ${names.join(', ')}. Use qvac help ${name}.`
}
