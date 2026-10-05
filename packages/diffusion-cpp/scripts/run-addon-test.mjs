import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const testDir = fileURLToPath(new URL('../build/test/unit/', import.meta.url))
const binary = fileURLToPath(
  new URL(
    `../build/test/unit/addon-test${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url
  )
)
const env = { ...process.env }

if (process.platform === 'linux' && !/(^|:)suppressions=/.test(env.LSAN_OPTIONS || '')) {
  const suppression = fileURLToPath(new URL('../test/unit/lsan-libdbus.supp', import.meta.url))
  env.LSAN_OPTIONS = [env.LSAN_OPTIONS, `suppressions=${suppression}`].filter(Boolean).join(':')
}

const result = spawnSync(
  binary,
  [...process.argv.slice(2), '--gtest_output=xml:cpp-test-results.xml'],
  {
    cwd: testDir,
    env,
    stdio: 'inherit'
  }
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1
