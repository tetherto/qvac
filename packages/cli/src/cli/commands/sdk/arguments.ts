// Explicit HTTP flags distinguish legacy API launches from the peer-host command.
// Keep these aliases for managed servers in the provider and editor integrations.
export function sdkArguments(argv: string[]): string[] | null {
  if (argv[0] === 'sdk') return argv.slice(1)
  if (argv[0] !== 'serve') return null
  const separator = argv.indexOf('--')
  const options = separator < 0 ? argv : argv.slice(0, separator)
  return options[1] === 'openai' || options.includes('--openai') || options.includes('--no-default')
    ? argv
    : null
}
