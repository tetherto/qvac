import type { CommandRoute, LaunchOptions, ParsedCommand } from '@qvac/cli-kit/launch'
import { CHAT, FLAGS, command, envName, flags, paramKey } from '@qvac/cli-kit/launch'
import type { Command, Bail } from 'paparam'
type ParseFailure = Error & { bail?: Bail }
// The one place paparam is set up, for both launchers and the app: one command, its flags, env
// and help. duck has no subcommands: every word is part of the first message.
import { arg, bail, footer, header, sloppy, summary } from 'paparam'

// the device flags a chat needs: where its state is, which model, and how it joins the account
const DEVICE = [
  'data-dir',
  'storage',
  'config',
  'temp',
  'no-color',
  'model',
  'join',
  'device-join',
  'bootstrap',
  'skip-setup',
  'fake-models'
]
// Asking for help or the version is never ambient, so neither reads an env var.
const NO_ENV = new Set(['version'])
const FALSE = new Set(['', '0', 'false', 'no', 'off'])
const HELP = new Set(['--help', '-h'])
const run = (...a: Parameters<(typeof import('./chat.js'))['runChat']>) =>
  import('./chat.js').then((m) => m.runChat(...a))
const help: CommandRoute = {
  where: 'launcher',
  run: (...a: Parameters<(typeof import('./help.js'))['runHelp']>) =>
    import('./help.js').then((m) => m.runHelp(...a))
}

export class UsageError extends Error {
  code: number
  constructor(message: string | undefined) {
    super(message)
    this.code = 2
  }
}

// the command keeps what it parsed, so every parse builds its own tree
export function tree({ version = '' } = {}) {
  return command(
    'duck',
    { where: 'app', run },
    header(`duck ${version}`.trimEnd() + ' — QV.AC chat in your terminal.'),
    summary(
      'Open chat, setting this device up on first use. The words after duck are your first message.'
    ),
    arg('[message]', 'Your first message'),
    sloppy({ args: true }),
    ...flags([...DEVICE, ...CHAT, 'version']),
    footer('Every flag also reads DUCK_<FLAG_NAME>, e.g. DUCK_DATA_DIR.'),
    bail(rethrow)
  )
}

// { command, action, words, options, where }: what the launcher runs, or hands to the app
export function parseArgs(
  argv: string[],
  { env = {} }: { env?: Record<string, string | undefined> } = {}
): ParsedCommand {
  // everything after `--` is part of the message, even a flag
  const literal = argv.indexOf('--')
  const head = literal === -1 ? argv : argv.slice(0, literal)
  const tail = literal === -1 ? [] : argv.slice(literal + 1)
  const asked = head.some((word: string) => HELP.has(word))
  const leaf = parse(head.filter((word: string) => !asked || !HELP.has(word)))
  const options = { ...readEnv(env), ...optionsOf(leaf) }
  if ('NO_COLOR' in env) {
    options.noColor ??= true
  }

  if (asked) {
    return parsed('help', { options, where: 'launcher' })
  }

  if (options.version) {
    return parsed('version', { options, where: 'launcher' })
  }

  return parsed('chat', { words: [...leaf.positionals, ...tail], options, where: 'app' })
}

// The runner a command path names: help prints in the launcher, everything else is the chat.
export function find(command: string) {
  return command === 'help' ? help : tree().qvac
}

function parse(argv: string[]): Command {
  try {
    return tree().parse(argv, { sync: true, silent: true, run: false })!
  } catch (caught) {
    const error = caught as ParseFailure
    if (!error.bail) throw error
    throw usageError(error.bail, argv)
  }
}

const parsed = (
  command: string,
  {
    words = [],
    options = {},
    where
  }: { words?: string[]; options?: LaunchOptions; where: ParsedCommand['where'] }
): ParsedCommand => ({ command, action: null, words, options, where })

function optionsOf(leaf: Command) {
  const options: Record<string, string | boolean | undefined> = {}
  for (const f of FLAGS) {
    const name = paramKey(f)
    if (f.key in options || !(name in leaf.indices.flags)) {
      continue
    }

    options[f.key] = f.name.startsWith('no-')
      ? !leaf.flags[name]
      : (leaf.flags[name] as string | boolean | undefined)
  }

  return options as LaunchOptions
}

export function readEnv(env: Record<string, string | undefined>, prefix = 'DUCK'): LaunchOptions {
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

function rethrow(reason: Bail): never {
  throw Object.assign(new Error(reason.reason), { bail: reason })
}

function usageError({ reason, flag }: Bail, argv: string[]) {
  const given = flag && (flag.long ? '--' : '-') + flag.name
  // as typed, so `--=x` reads as itself
  const name = argv.find((word: string) => word === given || word.startsWith(given + '=')) || given
  if (reason === 'UNKNOWN_FLAG') {
    return new UsageError(`unknown option ${name}. Use duck --help.`)
  }

  if (reason === 'INVALID_FLAG') {
    return new UsageError(flag?.value ? `${name} takes no value` : `missing value for ${name}`)
  }

  return new UsageError(`${reason}: duck [message]`)
}
