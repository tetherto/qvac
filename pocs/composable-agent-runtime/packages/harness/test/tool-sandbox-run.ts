const commands = [
  [
    'bun',
    'test',
    'test/weather-transport-integration.test.ts',
    'test/weather-proxy.test.ts',
    'test/desktop-executor.test.ts',
    'test/tool-sandbox-profile.test.ts',
    'test/tool-sandbox-lifecycle.test.ts',
    'test/tool-sandbox-wire.test.ts'
  ],
  ['bun', 'test/build-tool-sandbox-probe.ts'],
  ['bun', 'test/build-desktop-tool-sandbox-probe.ts'],
  ['brittle-bare', 'test/tool-sandbox-real.test.ts'],
  ['brittle-bare', 'test/tool-sandbox-desktop-real.test.ts']
] as const

const root = new URL('..', import.meta.url).pathname
for (const command of commands) {
  const child = Bun.spawn([...command], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}
