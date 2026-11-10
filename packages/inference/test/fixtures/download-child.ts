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
import fs from 'bare-fs'
import { AbortController } from 'bare-abort-controller'
import { setConfig } from '@/runtime/state'
import { downloadModelFromHttp } from '@/handlers/load-model/http'
import { acquireDownloadLock } from '@/handlers/load-model/download-lock'

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
