import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getClientLogger } from '@/logging'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STUB_HARNESS_ERROR = 'QVAC_TEST_STUB_HARNESS_STARTED'

const logs: { level: string; message: string }[] = []
getClientLogger().addTransport((level, _namespace, message) => {
  logs.push({ level, message })
})

delete process.env['QVAC_WORKER_PATH']
delete process.env['QVAC_CONFIG_PATH']

const project = fs.mkdtempSync(path.join(__dirname, 'tmp-bundle-stamp-'))
const workerDir = path.join(project, 'qvac', 'worker')
const entry = path.join(project, 'qvac', 'worker.entry.mjs')
fs.mkdirSync(workerDir, { recursive: true })
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'app' }))
fs.writeFileSync(
  path.join(workerDir, 'index.js'),
  `export async function start() { throw new Error('${STUB_HARNESS_ERROR}') }\n`
)
fs.writeFileSync(path.join(workerDir, 'index.bundle'), '')
fs.writeFileSync(entry, 'Bare.exit(7)\n')

function stampBundle(stamp: { qvacTarget: string; qvacSdkVersion: string }) {
  fs.writeFileSync(
    path.join(workerDir, 'package.json'),
    JSON.stringify({ name: 'worker', type: 'module', ...stamp })
  )
}

const installedVersion = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
    version: string
  }
).version

const originalCwd = process.cwd()
process.chdir(project)

const { getRPC, close } = await import('#rpc')

async function startFailure(): Promise<Error> {
  logs.length = 0
  return (await getRPC().then(
    () => {
      throw new Error('getRPC() resolved, but neither worker can start')
    },
    (thrown: unknown) => thrown
  )) as Error
}

test('a project bundle made for another target is skipped with a warning', async function (t) {
  t.timeout(20_000)
  stampBundle({ qvacTarget: 'pear-runtime', qvacSdkVersion: installedVersion })

  const error = await startFailure()

  const warning = logs.find((log) => log.level === 'warn')?.message ?? ''
  t.ok(
    warning.includes(`The worker in ${workerDir} was bundled for pear-runtime`),
    `warning names the bundle's target: ${warning}`
  )
  t.ok(
    warning.includes('qvac bundle sdk --target bare-sidecar'),
    `warning names the command for this target: ${warning}`
  )
  t.ok(
    logs.some((log) => log.message.includes(`Using worker entry: ${entry}`)),
    'resolution falls back to qvac/worker.entry.mjs'
  )
  t.is((error as { name?: string }).name, 'WORKER_STARTUP_FAILED')
  t.not(
    (error.cause as Error | undefined)?.message,
    STUB_HARNESS_ERROR,
    'the skipped bundle was not started'
  )
})

test('a project bundle made by another SDK version is used with a warning', async function (t) {
  t.timeout(20_000)
  t.teardown(async () => {
    try {
      await close()
    } catch {}
    process.chdir(originalCwd)
    fs.rmSync(project, { recursive: true, force: true })
  })
  stampBundle({ qvacTarget: 'bare-sidecar', qvacSdkVersion: '0.0.1' })

  const error = await startFailure()

  const warning = logs.find((log) => log.level === 'warn')?.message ?? ''
  t.ok(
    warning.includes('was bundled by @qvac/sdk 0.0.1'),
    `warning names the bundling SDK version: ${warning}`
  )
  t.ok(
    warning.includes(`@qvac/sdk ${installedVersion} is installed`),
    `warning names the installed SDK version: ${warning}`
  )
  t.ok(
    logs.some((log) => log.message.includes(`Using bundled worker: ${workerDir}`)),
    'resolution uses the project bundle'
  )
  t.is(
    (error.cause as Error | undefined)?.message,
    STUB_HARNESS_ERROR,
    'the bundle harness was started'
  )
})
