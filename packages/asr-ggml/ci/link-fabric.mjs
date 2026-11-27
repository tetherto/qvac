// Native CI restores Fabric into the workspace, while ASR installs outside pnpm.
// Keep its headers, CMake metadata and runtime on that same provider after npm install.
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function linkFabric() {
  const pkg = fileURLToPath(new URL('..', import.meta.url))
  const fabric = fileURLToPath(new URL('../../fabric', import.meta.url))
  const config = join(fabric, 'prebuilds/share/qvac-fabric/cmake/qvac-fabricConfig.cmake')
  // Published-provider runs have no restored workspace prebuilds.
  if (!existsSync(config)) return
  const destination = join(pkg, 'node_modules/@qvac/fabric')
  if (existsSync(destination) && realpathSync(destination) === realpathSync(fabric)) return
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(fabric, destination, 'junction')
  console.log(`Linked @qvac/fabric -> ${fabric}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) linkFabric()
