const scripts = [
  'test:supervisor',
  'test:agents',
  'test:sync',
  'test:harness',
  'test:assistant',
  'test:task-shared',
  'test:task-cli',
  'test:skill-cli',
  'test:task-mobile',
  'test:crash'
]

for (const script of scripts) {
  const child = Bun.spawn(['bun', 'run', script], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
