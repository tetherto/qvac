import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { QVACRegistryClient } from '@qvac/registry-client'
import { initEnv } from '@/runtime/env'
import { closeRegistryClient } from '@/runtime/registry-client'

// Points the cache at a temp home and replaces the client's network methods.
export function stubClient(
  t: { teardown(fn: () => Promise<void>): void },
  methods: Record<string, unknown>
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-registry-cache-'))
  const argv = Bare.argv.slice()
  Bare.argv.length = 0
  Bare.argv.push('', '', JSON.stringify({ HOME_DIR: home }))
  initEnv()

  const proto = QVACRegistryClient.prototype as unknown as Record<string, unknown>
  const names = ['ready', 'close', ...Object.keys(methods)]
  const original = Object.fromEntries(names.map((name) => [name, proto[name]]))
  proto['ready'] = async () => {}
  proto['close'] = async function (this: { corestore: { close(): Promise<void> } }) {
    await this.corestore.close()
  }
  Object.assign(proto, methods)

  t.teardown(async () => {
    await closeRegistryClient()
    Object.assign(proto, original)
    Bare.argv.length = 0
    Bare.argv.push(...argv)
    initEnv()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}
