import { chmod, rm } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import stow from 'bare-stow'

const outputDirectory = new URL(
  './fixtures/.stow/desktop-tool-sandbox/',
  import.meta.url
)
await rm(fileURLToPath(outputDirectory), {
  recursive: true,
  force: true
})

const artifacts = stow(
  new URL('../tool-sandbox-child-entry.ts', import.meta.url).href,
  'bare-sidecar',
  new URL('entry.js', outputDirectory).href,
  {
    base: new URL('../../../', import.meta.url).href,
    hosts: [`${os.platform()}-${os.arch()}`]
  }
)
for await (const _artifact of artifacts);

const source = fileURLToPath(
  new URL('./fixtures/fake-obsidian.c', import.meta.url)
)
const executable = fileURLToPath(
  new URL('obsidian', outputDirectory)
)
const compiler = Bun.spawn(
  ['/usr/bin/clang', source, '-o', executable],
  { stdout: 'pipe', stderr: 'pipe' }
)
const compilerExit = await compiler.exited
if (compilerExit !== 0) {
  const stderr = await new Response(compiler.stderr).text()
  throw new Error(
    `fake Obsidian compilation failed: ${stderr.trim()}`
  )
}
await chmod(executable, 0o700)
