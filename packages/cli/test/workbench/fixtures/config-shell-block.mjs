// Runs under Bare: configureHarness against a fake harness whose sandbox refuses to start.
import fs from 'bare-fs'
import path from 'bare-path'
import process from 'bare-process'
import { configureHarness } from '../../../dist/lib/runtime/harness-extension.js'

const [dir, allow] = process.argv.slice(2)
const file = path.join(dir, 'cli-runtime-config.json')
const harnessConfig = {
  maxToolRounds: 40,
  reasoningBudget: 512,
  thinking: 'plan',
  wording: { toolRepeated: 'Once is enough.', guidelines: { 'one-action-at-a-time': false } },
  allowUnsandboxedShell: allow === 'allow',
  plugins: [{ id: 'coding' }, { id: 'sandbox-macos' }, { id: 'egress-proxy' }],
  policy: { files: { write: [dir] }, network: { mode: 'hosts', hosts: ['github.com'] } },
  delegation: { enabled: false }
}
fs.writeFileSync(
  file,
  JSON.stringify({ config: { core: { dataDir: dir }, harness: harnessConfig } })
)
process.env.QVAC_CLI_CONFIG = file

const runs = []
const added = []
const harness = {
  toolNames: ['read_file', 'exec'],
  addPlugin(plugin) {
    if (plugin.name === 'sandbox-macos') {
      return Promise.reject(new Error('sandbox-exec is missing'))
    }

    added.push(plugin)
    return Promise.resolve()
  },
  tools() {
    return Promise.resolve(
      this.toolNames.map((name) => ({ name, toolset: name === 'exec' ? 'exec' : 'files' }))
    )
  },
  completion(context) {
    runs.push(context)
    return []
  }
}
const quiet = { info() {}, error() {} }

await configureHarness(harness, quiet, { platform: 'darwin' })
const events = []
for (const context of [
  { agent: { id: 'a' }, agents: { b: { id: 'b' } }, messages: [] },
  { agent: { id: 'a' }, messages: [], maxToolRounds: 3, wording: { toolRepeated: 'Mine.' } },
  { agent: { id: 'a' }, messages: [], parentRunId: 'p' },
  { agent: { id: 'a' }, messages: [], resume: true, generationParams: { reasoning_budget: -1 } }
]) {
  for await (const event of harness.completion(context)) {
    events.push(event)
  }
}

// the sandbox the coding plugin would get, driven as its session drives it
const provider = added.find((p) => p.provides?.includes('sandbox'))
let shell = null
if (provider) {
  const workspace = await provider.setup({}).services.sandbox.open(dir, {})
  const ran = await workspace.exec('echo out; echo err >&2; pwd; exit 3', { cwd: dir })
  const slow = await workspace.exec('sleep 5', { cwd: dir, timeoutMs: 200 })
  const job = await workspace.start('sleep 30', { cwd: dir })
  await job.stop()
  shell = { ran, slow: slow.exitCode, stopped: true }
}

const status = JSON.parse(fs.readFileSync(path.join(dir, 'cli-host-status.json'), 'utf8'))
const order = added.map((p) => p.name)
console.log(JSON.stringify({ status, runs, events, order, shell }))
