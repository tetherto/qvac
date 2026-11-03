import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { AbortController } from 'bare-abort-controller'
import { QVACRegistryClient } from '@qvac/registry-client'
import { initEnv } from '@/runtime/env'
import { closeRegistryClient } from '@/runtime/registry-client'
import { downloadSingleFileFromRegistry } from '@/handlers/load-model/registry-download-utils'

type DownloadOptions = { signal?: { aborted: boolean }; clearBlocksOnCancel?: () => boolean }

function stubClient(t: ReturnType<typeof test>, onDownload: (opts: DownloadOptions) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-registry-clear-'))
  const argv = Bare.argv.slice()
  Bare.argv.length = 0
  Bare.argv.push('', '', JSON.stringify({ HOME_DIR: home }))
  initEnv()

  const proto = QVACRegistryClient.prototype as unknown as Record<string, unknown>
  const original = {
    ready: proto['ready'],
    close: proto['close'],
    downloadBlob: proto['downloadBlob']
  }
  proto['ready'] = async () => {}
  proto['close'] = async function (this: { corestore: { close(): Promise<void> } }) {
    await this.corestore.close()
  }
  proto['downloadBlob'] = async (_binding: unknown, opts: DownloadOptions) => {
    onDownload(opts)
    throw new Error('Download cancelled')
  }

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

const binding = {
  coreKey: 'a'.repeat(64),
  blockOffset: 0,
  blockLength: 1,
  byteOffset: 0,
  byteLength: 4,
  sha256: 'b'.repeat(64)
}

test('downloadSingleFileFromRegistry: clearCache reaches the client as clearBlocksOnCancel', async (t) => {
  let clearCache = false
  let seen: boolean | undefined
  const ac = new AbortController()
  const home = stubClient(t, (opts) => {
    // The SDK flags clearCache on the transfer before it aborts.
    clearCache = true
    ac.abort(undefined)
    seen = opts.clearBlocksOnCancel?.()
  })

  await t.exception(
    downloadSingleFileFromRegistry(
      'model.gguf',
      's3',
      path.join(home, 'models', 'model.gguf'),
      'model.gguf',
      'key',
      4,
      '',
      undefined,
      ac.signal,
      binding,
      undefined,
      () => clearCache
    )
  )
  t.is(seen, true, 'client reads clearCache at cancel time')
})
