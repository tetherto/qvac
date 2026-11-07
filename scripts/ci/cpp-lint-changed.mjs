#!/usr/bin/env node
// Lints the C/C++ a change touched in one package: clang-format on the changed lines, then clang-tidy (warnings as
// errors) on the changed sources in build/compile_commands.json. Run from the package directory after bare-make
// generate, as `node ../../scripts/ci/cpp-lint-changed.mjs --base <commit>`.

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const EXTENSIONS = 'c,cc,cpp,cxx,h,hh,hpp,hxx'
const SOURCE = /\.(c|cc|cpp|cxx)$/

const { base } = parseArgs({ options: { base: { type: 'string' } } }).values
// A value starting with "-" would reach git as an option.
if (!/^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/.test(base ?? ''))
  throw new Error(`--base '${base}' is not a commit`)

const formatOk = checkFormat()
const tidyOk = runTidy()
if (!formatOk || !tidyOk) {
  console.log(
    `::error::C++ format ${formatOk ? 'passed' : 'failed'}, clang-tidy ${tidyOk ? 'passed' : 'failed'}`
  )
  process.exit(1)
}

function checkFormat() {
  const r = spawnSync(
    'git-clang-format',
    ['--binary', 'clang-format', '--extensions', EXTENSIONS, '--diff', base, '--', '.'],
    {
      stdio: 'inherit'
    }
  )
  if (r.status === 0) return true
  console.log(
    `::error title=Unformatted C++ files::Run git-clang-format --binary clang-format --extensions ${EXTENSIONS} ${base} -- .`
  )
  return false
}

function runTidy() {
  const changed = git([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    '--relative',
    base,
    'HEAD',
    '--',
    '.'
  ])
  if (!changed.some((f) => SOURCE.test(f))) {
    console.log('No C/C++ sources changed in this package; skipping clang-tidy.')
    return true
  }
  const helper = readdirSync('build', { recursive: true })
    .map(String)
    .find((f) => f.endsWith('clang-tidy-helper.py'))
  if (!helper) throw new Error('clang-tidy-helper.py not found in build/')
  const tool = join('build', helper)
  const units = new Set(lines(tool, ['build/compile_commands.json', '--files']))
  const files = changed.filter((f) => SOURCE.test(f) && units.has(f))
  if (!files.length) {
    console.log('Changed sources are not in compile_commands.json; skipping clang-tidy.')
    return true
  }
  // The helper prints `clang-tidy -p <dir> ... --header-filter='<re>'`.
  const cmd = lines(tool, ['build/compile_commands.json', '--clang-tidy-cmd']).join(' ')
  const buildDir = (cmd.match(/^clang-tidy -p (\S+)/) || [])[1]
  const headerFilter = (cmd.match(/--header-filter='([^']+)'/) || [])[1]
  console.log(`Linting ${files.length} changed file(s):\n  ${files.join('\n  ')}`)
  const r = spawnSync(
    'clang-tidy',
    ['-p', buildDir, ...files, `--header-filter=${headerFilter}`, '--warnings-as-errors=*'],
    {
      stdio: 'inherit'
    }
  )
  if (r.status === 0) return true
  console.log('::error title=Static analysis failed::clang-tidy found issues.')
  return false
}

function git(args) {
  return lines('git', args)
}

function lines(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}
