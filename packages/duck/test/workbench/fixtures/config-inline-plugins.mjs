// Runs under Bare: configureHarness on a runtime config whose plugins are inline markers.
import fs from 'bare-fs'
import path from 'bare-path'
import process from 'bare-process'
import { configureHarness } from '../../../dist/lib/runtime/harness-extension.js'

const [file] = process.argv.slice(2)
process.env.QVAC_CLI_CONFIG = file
const { config } = JSON.parse(fs.readFileSync(file, 'utf8'))

const added = []
const harness = {
  toolNames: [],
  addPlugin(plugin) {
    added.push(plugin)
    this.toolNames.push(...(plugin.setup().tools || []).map((t) => t.name))
    return Promise.resolve()
  },
  tools() {
    return Promise.resolve(this.toolNames.map((name) => ({ name, toolset: 'team' })))
  },
  completion() {
    return []
  }
}
const quiet = { info() {}, error() {} }

await configureHarness(harness, quiet)
const greet = added.flatMap((p) => p.setup().tools || []).find((t) => t.name === 'greet')
const greeting = greet && (await greet.execute({ name: 'Ada' })).content

const status = JSON.parse(
  fs.readFileSync(path.join(config.core.dataDir, 'cli-host-status.json'), 'utf8')
)
const reads = Object.fromEntries(added.map((p) => [p.name, p.read]))
console.log(JSON.stringify({ status, greeting, reads }))
