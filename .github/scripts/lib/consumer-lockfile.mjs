import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
}

export function readPackageJson(repoRoot, packageDir) {
  return JSON.parse(readFileSync(join(resolve(repoRoot, packageDir), 'package.json'), 'utf8'))
}

// Packs package.json alone into <workDir>/<name>.tgz and returns its file: spec.
export function packManifestOnly(repoRoot, packageDir, workDir, name) {
  const stageDir = join(workDir, `${name}-stage`)
  mkdirSync(join(stageDir, 'package'), { recursive: true })
  copyFileSync(join(resolve(repoRoot, packageDir), 'package.json'), join(stageDir, 'package', 'package.json'))
  run('tar', ['-czf', join(workDir, `${name}.tgz`), 'package'], stageDir)
  return `file:./${name}.tgz`
}

// Resolves only the dependency tree (npm --package-lock-only), so no build or
// prebuild download is needed. `buildManifest(pack)` gets a packer bound to a
// temporary work dir and returns the consumer package.json.
export function resolveConsumerLockfile(repoRoot, prefix, buildManifest) {
  const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), `${prefix}-`))
  try {
    const manifest = buildManifest((packageDir, name) => packManifestOnly(repoRoot, packageDir, workDir, name))
    writeFileSync(join(workDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], workDir)
    return { manifest, lockfile: JSON.parse(readFileSync(join(workDir, 'package-lock.json'), 'utf8')) }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
