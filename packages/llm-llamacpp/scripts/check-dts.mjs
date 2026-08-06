// Type-checks the packed package from outside, with declaration emit on.
// A fixture inside the package cannot catch this: transitive dependencies are
// reachable from there, so declarations emit cleanly whatever the types say.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-llamacpp-dts-'))
const packDirectory = path.join(temporaryRoot, 'pack')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: packageRoot, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  return result
}

let status = 1

try {
  fs.mkdirSync(packDirectory)

  const packResult = run(npmCommand, ['pack', '--json', '--pack-destination', packDirectory])
  if (packResult.status !== 0) {
    process.stderr.write(packResult.stderr)
  } else {
    const packEntries = JSON.parse(packResult.stdout)
    if (packEntries.length !== 1 || typeof packEntries[0].filename !== 'string') {
      throw new Error('npm pack did not report exactly one llm-llamacpp tarball')
    }

    const tarballPath = path.join(packDirectory, packEntries[0].filename)
    const installResult = run(
      npmCommand,
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--no-save',
        '--install-strategy=nested',
        tarballPath
      ],
      { cwd: temporaryRoot, stdio: 'inherit' }
    )

    if (installResult.status !== 0) {
      status = installResult.status ?? 1
    } else {
      // Fixture and its config are copied from the package so both stay
      // reviewable here rather than embedded in this script.
      for (const fixture of ['test/types/consumer-emit.test-d.ts', 'tsconfig.dts.json']) {
        const destination = path.join(temporaryRoot, fixture)
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.copyFileSync(path.join(packageRoot, fixture), destination)
      }

      const typecheckResult = run(
        process.execPath,
        [
          path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
          '--project',
          path.join(temporaryRoot, 'tsconfig.dts.json')
        ],
        { cwd: temporaryRoot, stdio: 'inherit' }
      )
      status = typecheckResult.status ?? 1
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

if (status !== 0) {
  process.exit(status)
}

console.log('Packed llm-llamacpp declarations emit cleanly for an external consumer.')
