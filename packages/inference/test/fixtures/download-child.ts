// A separate engine process for the cross-process download tests. It shares a
// models directory with the parent test and writes its outcome as JSON to
// <resultFile>, so the parent never depends on stdout flushing before exit.
//
// argv: download <cacheDir> <resultFile> <url>
//         Write <resultFile>.started, then download the URL into the models
//         directory.
//       hold-lock <cacheDir> <resultFile> <resourceKey> <holdMs>
//         Take the download lock, report it, then exit after <holdMs> without
//         releasing it, as a crashed process would.
//       registry-download <cacheDir> <resultFile> <registryPath> <gateFile>
//         Download a registry model with its own SDK home and a stubbed client
//         that writes half the file, creates <resultFile>.half, and finishes
//         once <gateFile> exists. Reports how many downloads the client ran.
import fs from 'bare-fs'
import crypto from 'bare-crypto'
import { AbortController } from 'bare-abort-controller'
import { setConfig } from '@/runtime/state'
import { downloadModelFromHttp } from '@/handlers/load-model/http'
import { downloadModelFromRegistry } from '@/handlers/load-model/registry'
import { acquireDownloadLock } from '@/handlers/load-model/download-lock'
import { stubClient } from './registry-client-stub'
import { MODEL_CONTENT } from './xproc-content'

const [mode, cacheDir, resultFile, arg, holdMs] = Bare.argv.slice(2)

function report(result: Record<string, unknown>): void {
  fs.writeFileSync(resultFile!, JSON.stringify(result))
}

async function run(): Promise<void> {
  setConfig({ cacheDirectory: cacheDir!, loggerConsoleOutput: false })

  if (mode === 'download') {
    fs.writeFileSync(`${resultFile!}.started`, '')
    const modelPath = await downloadModelFromHttp(arg!)
    report({ ok: true, path: modelPath })
    Bare.exit(0)
  }

  if (mode === 'registry-download') {
    fs.writeFileSync(`${resultFile!}.started`, '')
    const gateFile = holdMs!
    let downloads = 0
    const home = stubClient(
      { teardown: () => {} },
      {
        downloadModel: async (_path: string, _source: string, options: { outputFile: string }) => {
          downloads++
          const half = MODEL_CONTENT.length / 2
          const fd = fs.openSync(options.outputFile, 'w')
          fs.writeSync(fd, MODEL_CONTENT.subarray(0, half))
          fs.writeFileSync(`${resultFile!}.half`, '')
          while (!fs.existsSync(gateFile)) {
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
          }
          fs.writeSync(fd, MODEL_CONTENT.subarray(half))
          fs.closeSync(fd)
          return { path: options.outputFile }
        }
      }
    )
    const modelPath = await downloadModelFromRegistry(
      arg!,
      'xproc',
      undefined,
      undefined,
      undefined,
      {
        expectedSize: MODEL_CONTENT.length,
        sha256Checksum: crypto.createHash('sha-256').update(MODEL_CONTENT).digest('hex')
      }
    )
    report({ ok: true, path: modelPath, downloads, home })
    Bare.exit(0)
  }

  if (mode === 'hold-lock') {
    await acquireDownloadLock(arg!, new AbortController().signal)
    report({ ok: true, locked: true })
    setTimeout(() => Bare.exit(0), Number(holdMs))
    return
  }

  report({ ok: false, error: `unknown mode: ${mode}` })
  Bare.exit(1)
}

run().catch((error: unknown) => {
  report({ ok: false, error: error instanceof Error ? error.message : String(error) })
  Bare.exit(1)
})
