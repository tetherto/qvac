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
const harness = {
  toolNames: ['read_file', 'exec'],
  addPlugin(plugin) {
    return plugin.name === 'sandbox-macos'
      ? Promise.reject(new Error('sandbox-exec is missing'))
      : Promise.resolve()
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
  { agent: { id: 'a' }, messages: [], maxToolRounds: 3 },
  { agent: { id: 'a' }, messages: [], parentRunId: 'p' },
  { agent: { id: 'a' }, messages: [], resume: true, generationParams: { reasoning_budget: -1 } }
]) {
  for await (const event of harness.completion(context)) {
    events.push(event)
  }
}

const status = JSON.parse(fs.readFileSync(path.join(dir, 'cli-host-status.json'), 'utf8'))
console.log(JSON.stringify({ status, runs, events }))
