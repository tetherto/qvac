const scripts = ['test:node', 'test:bun', 'test:bare']
const root = new URL('..', import.meta.url).pathname

for (const script of scripts) {
  const child = Bun.spawn(['bun', 'run', script], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
