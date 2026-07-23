import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-base-dts-'))
const temporaryPackage = path.join(temporaryRoot, 'node_modules', '@qvac', 'infer-base')

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

let status = 1

try {
  for (const relativePath of ['package.json', 'index.d.ts']) {
    copyFile(path.join(packageRoot, relativePath), path.join(temporaryPackage, relativePath))
  }

  for (const sourcePath of walk(path.join(packageRoot, 'src'))) {
    if (!sourcePath.endsWith('.d.ts')) continue
    const relativePath = path.relative(packageRoot, sourcePath)
    copyFile(sourcePath, path.join(temporaryPackage, relativePath))
  }

  fs.cpSync(
    path.join(packageRoot, 'node_modules', 'bare-events'),
    path.join(temporaryRoot, 'node_modules', 'bare-events'),
    { recursive: true }
  )

  fs.cpSync(path.join(packageRoot, 'test', 'types'), path.join(temporaryRoot, 'test', 'types'), {
    recursive: true
  })
  copyFile(
    path.join(packageRoot, 'tsconfig.dts.json'),
    path.join(temporaryRoot, 'tsconfig.dts.json')
  )

  const result = spawnSync(
    process.execPath,
    [
      path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      path.join(temporaryRoot, 'tsconfig.dts.json')
    ],
    {
      cwd: temporaryRoot,
      stdio: 'inherit'
    }
  )

  if (result.error) throw result.error
  status = result.status ?? 1
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

if (status !== 0) {
  process.exit(status)
}

console.log('Published infer-base declarations type-check for a CommonJS consumer.')
