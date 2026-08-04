import { rm } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import stow from 'bare-stow'

const outputDirectory = new URL('../.stow/tool-sandbox/', import.meta.url)
await rm(fileURLToPath(outputDirectory), {
  recursive: true,
  force: true
})

const artifacts = stow(
  import.meta.resolve('@qvac/harness/tool-sandbox-child-entry'),
  'bare-sidecar',
  new URL('entry.js', outputDirectory).href,
  {
    base: new URL('../../../', import.meta.url).href,
    hosts: [`${os.platform()}-${os.arch()}`]
  }
)
for await (const _artifact of artifacts);

console.log(
  fileURLToPath(new URL('entry.bundle', outputDirectory))
)
