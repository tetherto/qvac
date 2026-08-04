import { chmod, rm } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import stow from 'bare-stow'

const outputDirectory = new URL('./fixtures/.stow/tool-sandbox-probe/', import.meta.url)
await rm(fileURLToPath(outputDirectory), { recursive: true, force: true })

const artifacts = stow(
  new URL('./fixtures/tool-sandbox-probe.ts', import.meta.url).href,
  'bare-sidecar',
  new URL('entry.js', outputDirectory).href,
  {
    base: new URL('../../../', import.meta.url).href,
    hosts: [`${os.platform()}-${os.arch()}`]
  }
)
for await (const _artifact of artifacts);

const serviceProbeSource = fileURLToPath(
  new URL('./fixtures/tool-sandbox-service-probe.c', import.meta.url)
)
const serviceProbeExecutable = fileURLToPath(
  new URL('service-probe', outputDirectory)
)
const compiler = Bun.spawn(
  ['/usr/bin/clang', serviceProbeSource, '-o', serviceProbeExecutable],
  { stdout: 'pipe', stderr: 'pipe' }
)
const compilerExit = await compiler.exited
if (compilerExit !== 0) {
  const stderr = await new Response(compiler.stderr).text()
  throw new Error(`service probe compilation failed: ${stderr.trim()}`)
}
await chmod(serviceProbeExecutable, 0o700)

const validation = Bun.spawn([serviceProbeExecutable], {
  stdout: 'pipe',
  stderr: 'pipe'
})
const [validationExit, validationOutput] = await Promise.all([
  validation.exited,
  new Response(validation.stdout).text()
])
if (validationExit !== 0 || validationOutput.trim() !== '0') {
  throw new Error(
    `service probe baseline lookup failed: exit ${validationExit}, result ${validationOutput.trim()}`
  )
}
