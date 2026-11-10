import fs from '#fs'
import path from '#path'

export function packageVersion(root: string) {
  return readJson(path.join(root, 'package.json'))!.version
}

export function versionText(root: string) {
  const { name, version } = readJson(path.join(root, 'package.json'))!
  const lines = [`${name} ${version}`]
  for (const name of ['core', 'harness']) {
    const installed = installedVersion(root, `@qvac/${name}`)
    lines.push(`${name.padEnd(8)} ${installed ? installed.version : 'not installed'}`)
  }

  const bare = installedVersion(root, 'bare-runtime')
  if (bare) {
    lines.push(`${'bare'.padEnd(8)} ${bare.version}`)
  }

  return lines.join('\n')
}

function readJson(file: string, fallback?: null): { name: string; version: string } | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (fallback === undefined) {
      throw error
    }

    return fallback
  }
}

// npm may hoist dependencies above this package; pnpm exposes direct dependencies as links.
function installedVersion(root: string, name: string) {
  for (let directory = root; ; directory = path.dirname(directory)) {
    const manifest = readJson(path.join(directory, 'node_modules', name, 'package.json'), null)
    if (manifest) return manifest
    if (path.dirname(directory) === directory) return null
  }
}
