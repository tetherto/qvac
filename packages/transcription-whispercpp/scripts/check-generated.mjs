import { spawnSync } from 'node:child_process'

const generatedFiles = [
  'index.js',
  'index.d.ts',
  'whisper.js',
  'whisper.d.ts',
  'configChecker.js',
  'configChecker.d.ts',
  'addonLogging.js',
  'addonLogging.d.ts',
  'lib/error.js',
  'lib/error.d.ts'
]

const packageRoot = new URL('..', import.meta.url)

function runGit (args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: packageRoot,
    encoding: 'utf8',
    ...options
  })

  if (result.error) {
    throw result.error
  }

  return result
}

const untracked = runGit([
  'ls-files',
  '--others',
  '--',
  ...generatedFiles
])

if (untracked.status !== 0) {
  process.stderr.write(untracked.stderr)
  process.exit(untracked.status ?? 1)
}

if (untracked.stdout.trim()) {
  process.stderr.write(
    `Generated files are not tracked:\n${untracked.stdout}`
  )
  process.exit(1)
}

const diff = runGit(
  ['diff', '--exit-code', '--', ...generatedFiles],
  { stdio: 'inherit' }
)

if (diff.status !== 0) {
  process.exit(diff.status ?? 1)
}
