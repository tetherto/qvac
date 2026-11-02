'use strict'

const { spawnSync } = require('child_process')

const files = ['index.js', 'addon.js', 'index.d.ts', 'addon.d.ts', 'megaloc.js', 'megaloc.d.ts']
const result = spawnSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', ...files],
  {
    cwd: require('path').resolve(__dirname, '..'),
    encoding: 'utf8'
  }
)
if (result.error) throw result.error
if (result.status !== 0) throw new Error(result.stderr || 'Unable to check generated files')
if (result.stdout.trim()) {
  throw new Error(`Generated files differ from the checked-in sources:\n${result.stdout}`)
}
