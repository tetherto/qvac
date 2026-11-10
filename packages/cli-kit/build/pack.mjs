// Pack the npm archive from a clean copy of the publication inputs, so no local node_modules leaks in.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// npm.cmd is a batch file, which Windows only runs through a shell
const windows = process.platform === 'win32'

// check: the product's publish gate, run from its root before anything is copied
export function pack({ root, destination = root, check = 'scripts/check-publish-ready.mjs' }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-distribution-'))
  const npm = (args) =>
    execFileSync(windows ? 'npm.cmd' : 'npm', args, {
      cwd: stage,
      stdio: 'inherit',
      shell: windows
    })
  const copy = (source, target) =>
    fs.cpSync(source, target, {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
      filter: (file) => !file.split(path.sep).includes('node_modules')
    })

  try {
    execFileSync(process.execPath, [check], { cwd: root, stdio: 'inherit' })
    // These are the manifest's publication inputs. npm applies its files allowlist
    // when creating the archive.
    for (const name of [
      'package.json',
      'npm-shrinkwrap.json',
      'dist',
      'scripts',
      'patches',
      'skills',
      'docs',
      'README.md',
      'LICENSE',
      'NOTICE'
    ]) {
      const source = path.join(root, name)
      if (!fs.existsSync(source)) continue
      copy(source, path.join(stage, name))
    }
    bundle({ root, stage, copy })
    fs.mkdirSync(destination, { recursive: true })
    npm(['pack', '--pack-destination', destination])
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

// A bundled dependency ships inside the archive, under the package's node_modules, where npm
// applies its files allowlist. It is copied from its real folder: pnpm links the workspace
// sibling, and npm reads a link's .gitignore, which hides a built dist. The manifest, and the
// lock when it names it, then take the version packed in place of the workspace: range, which
// only pnpm reads.
function bundle({ root, stage, copy }) {
  const manifest = path.join(stage, 'package.json')
  const lock = path.join(stage, 'npm-shrinkwrap.json')
  const pkg = read(manifest)
  const versions = {}
  for (const name of pkg.bundleDependencies || []) {
    const folder = path.join(stage, 'node_modules', name)
    copy(fs.realpathSync(path.join(root, 'node_modules', name)), folder)
    versions[name] = read(path.join(folder, 'package.json')).version
  }
  resolveWorkspace(pkg.dependencies, versions)
  write(manifest, pkg)
  if (fs.existsSync(lock)) {
    const shrinkwrap = read(lock)
    resolveWorkspace(shrinkwrap.packages[''].dependencies, versions)
    write(lock, shrinkwrap)
  }
}

// workspace:*, ^ and ~ take the packed version, as pnpm publishes them
function resolveWorkspace(dependencies, versions) {
  for (const [name, version] of Object.entries(versions)) {
    const spec = dependencies[name]
    if (!spec?.startsWith('workspace:')) continue
    const range = spec.slice('workspace:'.length)
    dependencies[name] =
      range === '*' ? version : range === '^' || range === '~' ? range + version : range
  }
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
