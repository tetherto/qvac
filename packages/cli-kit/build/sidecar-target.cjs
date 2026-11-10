'use strict'

// returns the Sidecar too so the host can drain its pipes (an unread one blocks the child)

module.exports = {
  name: 'sidecar',
  linked: false,
  offload: true,
  format: 'bundle',
  encoding: null,
  extension: '.bundle',
  module: 'cjs',
  hosts: ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'],
  generate({ bundleSpecifier, ipc }) {
    const source = `\
const path = require('path')
const Sidecar = require('bare-sidecar')
const stow = require('bare-stow/host')

const bundle = path.join(__dirname, ${JSON.stringify(bundleSpecifier)})

module.exports = {
  async start(args = [], opts = {}) {
    const sidecar = new Sidecar(bundle, args, opts)

    const ${ipc} = stow.wrap(sidecar)
    const exit = new Promise((resolve) =>
      sidecar.once('exit', (code, status) => resolve({ code, status }))
    )

    return { ${ipc}, sidecar, exit }
  }
}
`
    const types = `\
export function start(
  args?: string[],
  opts?: object
): Promise<{
  ipc: import('bare-stow/host').IPC
  sidecar: import('bare-sidecar')
  exit: Promise<{ code: number | null; status: number | null }>
}>
`

    return [{ source }, { extension: '.d.ts', source: types }]
  }
}
