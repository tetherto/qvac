// A second QVAC process for the registry store tests. It reports to
// <resultFile> as JSON, so the parent never depends on stdout flushing.
//
// argv: <mode> <home> <resultFile> <ms> [graceMs]
//   hold    Lease the registry client for <ms>, then release it and stay alive
//           without closing the engine, as an idle long-lived process does.
//   busy    Take back-to-back 30 ms leases for <ms>, as a busy server does,
//           then report how many ran.
//   legacy  Open the store the way an SDK before leases does, and keep it until
//           exit after <ms>.
import fs from 'bare-fs'
import { acquireRegistryClient } from '@/runtime/registry-client'
import { holdStore, useRegistryHome } from './registry-store'

const [mode, home, resultFile, ms, graceMs] = Bare.argv.slice(2)
const durationMs = Number(ms)

function report(result: Record<string, unknown>): void {
  fs.writeFileSync(resultFile!, JSON.stringify(result))
}

const sleep = (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))

async function run(): Promise<void> {
  useRegistryHome(home!, graceMs === undefined ? {} : { graceMs: Number(graceMs) })

  if (mode === 'hold') {
    const lease = await acquireRegistryClient({ wait: 'download' })
    report({ ok: true, holding: true })
    await sleep(durationMs)
    await lease[Symbol.asyncDispose]()
    report({ ok: true, releasedAt: Date.now() })
    // Idle, engine still open: today's SDK would keep the store from here on.
    setTimeout(() => Bare.exit(0), 20_000)
    return
  }

  if (mode === 'busy') {
    const end = Date.now() + durationMs
    let leases = 0
    while (Date.now() < end) {
      await using _lease = await acquireRegistryClient({ wait: 'download' })
      if (leases === 0) report({ ok: true, holding: true })
      leases++
      await sleep(30)
    }
    report({ ok: true, leases, endedAt: Date.now() })
    Bare.exit(0)
  }

  if (mode === 'legacy') {
    await holdStore()
    report({ ok: true, holding: true })
    setTimeout(() => Bare.exit(0), durationMs)
    return
  }

  report({ ok: false, error: `unknown mode: ${mode}` })
  Bare.exit(1)
}

run().catch((error: unknown) => {
  report({ ok: false, error: error instanceof Error ? error.message : String(error) })
  Bare.exit(1)
})
