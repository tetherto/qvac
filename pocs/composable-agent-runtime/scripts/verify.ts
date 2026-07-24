const scripts = [
  'typecheck',
  'lint:supervisor',
  'test',
  'test:subsets',
  'test:pack'
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
