#!/usr/bin/env node
/**
 * Install the locked bare toolchain and put its bin directory first on PATH.
 *
 * The bin directory holds bare-make and every tool its dependencies ship:
 * clang, clang++, lld, llvm-profdata, llvm-cov, clang-format, cmake, ninja and
 * nasm. Putting it first makes coverage, formatting and any direct compiler call
 * use the same LLVM bare-make compiles with.
 *
 * In a GitHub Actions step the directory is appended to GITHUB_PATH, so it
 * applies to the following steps. Elsewhere it is only printed.
 *
 * Usage:
 *   node .github/bare-toolchain/install.mjs
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const bin = join(dir, 'node_modules', '.bin')
// npm and the tool shims are .cmd files on Windows, which spawn only through a shell.
const shell = process.platform === 'win32'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell, ...options })
  // A missing binary sets error and leaves status null. Report that instead of "exited with null".
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`)
  }
}

run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir })

if (process.env.GITHUB_PATH) {
  appendFileSync(process.env.GITHUB_PATH, `${bin}\n`)
} else {
  console.log(`Add ${bin} to the front of PATH to use the locked toolchain.`)
}

// Windows spells it Path, and a second PATH key beside it is not the one used.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
const env = { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` }
for (const tool of ['bare-make', 'clang', 'llvm-profdata']) {
  run(tool, ['--version'], { env })
}
