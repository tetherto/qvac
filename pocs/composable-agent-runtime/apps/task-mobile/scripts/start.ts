const build = Bun.spawn(['bun', 'run', 'build:worklets'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdout: 'inherit',
  stderr: 'inherit'
})
const buildExit = await build.exited
if (buildExit !== 0) process.exit(buildExit)

const expo = Bun.spawn(['bunx', 'expo', 'start', '--dev-client'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdout: 'inherit',
  stderr: 'inherit'
})
process.exit(await expo.exited)
