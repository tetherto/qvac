// Type-checks the PACKED package from outside, with declaration emit on.
// In-package fixtures cannot catch this class of bug: from inside, transitive
// dependencies are reachable, so a type that is only nameable via
// `@qvac/infer-base` still emits fine. A consumer that does not hoist that
// dependency gets TS2742 instead. Installed with a nested layout to reproduce
// the strict case.
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
      fs.mkdirSync(path.join(temporaryRoot, 'test', 'types'), { recursive: true })
      fs.copyFileSync(
        path.join(packageRoot, 'test/types/consumer-emit.test-d.ts'),
        path.join(temporaryRoot, 'test/types/consumer-emit.test-d.ts')
      )
      fs.writeFileSync(
        path.join(temporaryRoot, 'tsconfig.dts.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'ES2022',
              moduleResolution: 'bundler',
              strict: true,
              declaration: true,
              emitDeclarationOnly: true,
              outDir: './dts-out',
              skipLibCheck: true,
              esModuleInterop: true,
              types: []
            },
            files: ['test/types/consumer-emit.test-d.ts']
          },
          null,
          2
        )
      )

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
