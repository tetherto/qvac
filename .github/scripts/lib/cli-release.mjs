import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

// A package that packs its own validated archive from a clean install of its
// shrinkwrap, through the kit's pack: the CLI and duck.
export function packsArchive (root, dir) {
  return existsSync(join(root, dir, 'scripts/pack-distribution.mjs'))
}

export function archivePath (directory, index, name) {
  const file = index[name]
  if (typeof file !== 'string' || basename(file) !== file || !file.endsWith('.tgz')) {
    throw new Error(`The ${name} release requires its validated train tarball`)
  }
  return resolve(directory, file)
}

export function validateArchive (manifest, { name, version, head }) {
  if (manifest.name !== name || manifest.version !== version || manifest.gitHead !== head) {
    throw new Error(`${name} archive name/version/gitHead does not match this release`)
  }
}

// Keep the package in the existing Nx dependency graph, replacing only its publish action.
// No archive path or release metadata is interpolated into shell command text.
export function withArchiveTarget (root, dir, action) {
  const file = join(root, dir, 'project.json')
  const original = readFileSync(file, 'utf8')
  const project = JSON.parse(original)
  project.targets ||= {}
  project.targets['nx-release-publish'] = {
    executor: 'nx:run-commands',
    cache: false,
    dependsOn: ['^nx-release-publish'],
    options: {
      cwd: root,
      commands: [{ command: 'node .github/scripts/release-train.mjs publish-archive', forwardAllArgs: false }],
    },
  }
  try {
    writeFileSync(file, JSON.stringify(project, null, 2) + '\n')
    return action()
  } finally {
    writeFileSync(file, original)
  }
}

// Every archive package's publish action replaced at once, innermost first.
export function withArchiveTargets (root, dirs, action) {
  return dirs.reduceRight((run, dir) => () => withArchiveTarget(root, dir, run), action)()
}
