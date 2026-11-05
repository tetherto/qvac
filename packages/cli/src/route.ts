// Commands that @qvac/cli 0.18 and earlier ran at the top level. They now run as
// `qvac sdk <command>`; the old form still works and names the new one.
const LEGACY_SDK_COMMANDS = new Set(['bundle', 'configure', 'doctor', 'openai', 'serve', 'verify'])

export interface Deprecation {
  used: string
  replacement: string
}

export type Route =
  | { kind: 'help'; exitCode: 0 | 1 }
  | { kind: 'version' }
  | { kind: 'sdk'; args: string[]; deprecation?: Deprecation }
  | { kind: 'error'; message: string }

export function route(argv: readonly string[]): Route {
  const [first, ...rest] = argv

  if (first === undefined) return { kind: 'help', exitCode: 1 }
  if (first === '-h' || first === '--help') return { kind: 'help', exitCode: 0 }
  if (first === 'help') {
    return rest.length === 0 ? { kind: 'help', exitCode: 0 } : route([...rest, '--help'])
  }
  if (first === '-V' || first === '--version') return { kind: 'version' }
  if (first === 'sdk') return { kind: 'sdk', args: rest }

  if (LEGACY_SDK_COMMANDS.has(first)) {
    // `sdk` was the only subcommand of `bundle`; `qvac sdk bundle` takes its
    // options directly.
    if (first === 'bundle' && rest[0] === 'sdk') {
      return {
        kind: 'sdk',
        args: ['bundle', ...rest.slice(1)],
        deprecation: { used: 'qvac bundle sdk', replacement: 'qvac sdk bundle' }
      }
    }
    return {
      kind: 'sdk',
      args: [first, ...rest],
      deprecation: { used: `qvac ${first}`, replacement: `qvac sdk ${first}` }
    }
  }

  const what = first.startsWith('-') ? 'option' : 'command'
  return { kind: 'error', message: `unknown ${what} '${first}'` }
}
