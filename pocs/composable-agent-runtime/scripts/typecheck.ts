const workspaces = [
  'packages/agents',
  'packages/sync',
  'packages/harness',
  'packages/assistant',
  'apps/task-shared',
  'apps/task-cli',
  'apps/task-mobile'
]
const root = new URL('..', import.meta.url).pathname

for (const workspace of workspaces) {
  const child = Bun.spawn(['bun', 'run', 'typecheck'], {
    cwd: `${root}/${workspace}`,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
