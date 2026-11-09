import type { RoutedCommand, LaunchOptions, ParsedCommand } from '@qvac/cli-kit/launch'
import { DEVICE, FLAGS, command, envName, flags, paramKey } from '@qvac/cli-kit/launch'
import type { Command, Bail } from 'paparam'
type ParseFailure = Error & { bail?: Bail; at?: Command }
interface TreeResult {
  leaf?: Command | undefined
  path: string[]
  words: string[]
  options: LaunchOptions
}
// The one place paparam is set up, for both launchers and the app: commands, flags, env and help.
import { bail, footer, header, summary } from 'paparam'
import { config } from './commands/config/index.js'
import { help } from './commands/help/index.js'
import { invite } from './commands/invite/index.js'
import { logs } from './commands/logs/index.js'
import { models } from './commands/models/index.js'
import { sdk } from './commands/sdk/index.js'
import { sdkArguments } from './commands/sdk/arguments.js'
import { serve } from './commands/serve/index.js'
import { status } from './commands/status/index.js'
import { workspace } from './commands/workspace/index.js'

const COMMANDS = [serve, invite, workspace, models, status, logs, config, help, sdk]
// Asking for help or the version is never ambient, so neither reads an env var.
const NO_ENV = new Set(['version'])
const FALSE = new Set(['', '0', 'false', 'no', 'off'])
const HELP = new Set(['--help', '-h'])
// qvac alone opens the app: the management TUI
const open = (...a: Parameters<(typeof import('./open.js'))['runOpen']>) =>
  import('./open.js').then((m) => m.runOpen(...a))

export class UsageError extends Error {
  code: number
  constructor(message: string | undefined) {
    super(message)
    this.code = 2
  }
}

// commands keep what they parsed, so every parse builds its own tree
export function tree({ version = '' } = {}) {
  return command(
    'qvac',
    { where: 'app', run: open },
    header(`QV.AC ${version}`.trimEnd() + ' — your most powerful device, everywhere.'),
    summary('Open the dashboard of this device, setting it up on first use.'),
    ...flags([...DEVICE, 'version']),
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

  // everything after `--` is words, even a command word
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

  const path = read.path
  const words = [...read.words, ...tail]
  if (asked) {
    return parsed(['help'], { words: path, options, where: 'launcher' })
  }

  if (options.version) {
    return parsed(['version'], { options, where: 'launcher' })
  }

  // sdk parses its own words under Node, after a global flag as after `qvac sdk`
  if (path[0] === 'sdk') {
    return parsed(['sdk'], {
      words: argv.slice(argv.indexOf('sdk') + 1),
      options,
      where: 'launcher'
    })
  }

  return routed({ path, words, options, leaf: read.leaf })
}

// The runner a command path names, for the app that runs a Core command the launcher parsed.
export function find(command: string, action?: string | null) {
  const names = [command, action].filter((name): name is string => !!name)
  let node: Command = tree()
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
    throw Object.assign(usageError(error.bail, argv), { at: error.bail.command })
  }

  return { leaf: leaf!, path: pathOf(leaf), words: leaf!.positionals, options: optionsOf(leaf) }
}

function routed({ path, words, options, leaf }: TreeResult): ParsedCommand {
  if (path.length === 0) {
    return parsed(['open'], { words, options, where: 'app' })
  }

  // a group alone names no command: qvac workspace
  if (!leaf || !(leaf as RoutedCommand).qvac.where) {
    throw new UsageError(takes(leaf!))
  }

  return parsed(path, { words, options, where: (leaf as RoutedCommand).qvac.where! })
}

const parsed = (
  [command = 'open', action = null]: Array<string | null | undefined>,
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

export function readEnv(env: Record<string, string | undefined>, prefix = 'QVAC'): LaunchOptions {
  const options: Record<string, string | boolean | undefined> = {}
  for (const f of FLAGS) {
    const value = env[envName(f, prefix)]
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

  // the root takes commands only: a word that names none is not a message
  if (at._definedCommands.size > 0) {
    return new UsageError(
      at.parent ? takes(at) : `unknown command ${arg?.value?.split(' ')[0]}. Use qvac --help.`
    )
  }

  return new UsageError(`unexpected "${arg?.value}": ${usage}`)
}

function takes(group: Command) {
  const names = [...group._definedCommands.keys()]
  const [name] = pathOf(group)

  return `${name} takes ${names.join(', ')}. Use qvac help ${name}.`
}
