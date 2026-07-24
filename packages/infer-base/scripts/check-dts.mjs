import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-base-dts-'))
const packDirectory = path.join(temporaryRoot, 'pack')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    ...options
  })

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
      throw new Error('npm pack did not report exactly one infer-base tarball')
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
        tarballPath
      ],
      {
        cwd: temporaryRoot,
        stdio: 'inherit'
      }
    )

    if (installResult.status !== 0) {
      status = installResult.status ?? 1
    } else {
      const fixturePaths = [
        'test/types/commonjs-api.ts',
        'test/types/native-abort-signal.ts',
        'tsconfig.dts.json',
        'tsconfig.dts.dom.json'
      ]
      for (const fixturePath of fixturePaths) {
        copyFile(path.join(packageRoot, fixturePath), path.join(temporaryRoot, fixturePath))
      }

      const configPaths = ['tsconfig.dts.json', 'tsconfig.dts.dom.json']
      status = 0
      for (const configPath of configPaths) {
        const typecheckResult = run(
          process.execPath,
          [
            path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
            '--project',
            path.join(temporaryRoot, configPath)
          ],
          {
            cwd: temporaryRoot,
            stdio: 'inherit'
          }
        )

        if (typecheckResult.status !== 0) {
          status = typecheckResult.status ?? 1
          break
        }
      }
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

if (status !== 0) {
  process.exit(status)
}

console.log('Packed infer-base declarations type-check for Bare and native consumers.')
