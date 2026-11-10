import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export function cliArchivePath (directory, index) {
  const file = index['@qvac/cli']
  if (typeof file !== 'string' || basename(file) !== file || !file.endsWith('.tgz')) {
    throw new Error('The CLI release requires its validated train tarball')
  }
  return resolve(directory, file)
}

export function validateCliArchive (manifest, { version, head }) {
  if (manifest.name !== '@qvac/cli' || manifest.version !== version || manifest.gitHead !== head) {
    throw new Error('CLI archive name/version/gitHead does not match this release')
  }
}

// Keep CLI in the existing Nx dependency graph, replacing only its publish action.
// No archive path or release metadata is interpolated into shell command text.
export function withCliArchiveTarget (root, dir, action) {
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
      commands: [{ command: 'node .github/scripts/release-train.mjs publish-cli-archive', forwardAllArgs: false }],
    },
  }
  try {
    writeFileSync(file, JSON.stringify(project, null, 2) + '\n')
    return action()
  } finally {
    writeFileSync(file, original)
  }
}
