const appRoot = new URL('..', import.meta.url).pathname

await run(['bun', 'run', 'build:worklets'])
await run(['bun', 'run', 'build:android-addons'])
await run(['bunx', 'expo', 'run:android', '--device'])

async function run(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: appRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
