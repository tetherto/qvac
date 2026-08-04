const mode = process.argv[2] ?? 'all'
const root = new URL('..', import.meta.url).pathname
const commands = new Map<string, readonly string[]>([
  [
    'node',
    [
      'node',
      '--experimental-strip-types',
      'node_modules/brittle/brittle-node.js',
      'test/all.ts'
    ]
  ],
  ['bare', ['bare', 'test/bare.ts']],
  [
    'spawn',
    [
      'node',
      '--experimental-strip-types',
      'node_modules/brittle/brittle-node.js',
      'test/spawned.ts'
    ]
  ]
])

await run(['bare', 'schema/build.ts'])
const selected = mode === 'all' ? [...commands.values()] : [requiredCommand(mode)]
for (const command of selected) await run(command)

function requiredCommand(name: string) {
  const command = commands.get(name)
  if (!command) throw new Error(`Unknown Sync test mode: ${name}`)
  return command
}

async function run(command: readonly string[]) {
  const child = Bun.spawn([...command], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
