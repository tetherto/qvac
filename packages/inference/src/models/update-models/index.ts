import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { generateModelsFileContent } from './codegen'
import {
  assignNames,
  compareModels,
  createHistoryFile,
  loadCurrentModels,
  separateUpdates
} from './history'
import { collectModels } from './registry'
import { formatSize } from './utils'

// This tool runs from the compiled build (bare resolves the `@/` alias only
// after tsc-alias), but regenerates the source catalog. Resolve both targets
// against the package root (cwd for `npm run`/`bun run`) so the location the
// build ran from does not matter.
const OUTPUT_FILE = path.join(os.cwd(), 'src', 'models', 'registry', 'models.ts')
const HISTORY_DIR = path.join(os.cwd(), 'src', 'models', 'history')

async function checkOnly(nonBlocking = false, showDuplicates = false): Promise<void> {
  const timeoutMs = 30000
  let timedOut = false

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      timedOut = true
      console.log('⏱️  Model check timed out')
      console.log("   Run 'bun check-models' manually to retry")
      resolve(null)
    }, timeoutMs)
  })

  try {
    const result = await Promise.race([
      (async () => {
        const remoteModels = await collectModels({ showDuplicates })
        const currentModels = loadCurrentModels(OUTPUT_FILE)

        remoteModels.sort(
          (a, b) => a.addon.localeCompare(b.addon) || a.registryPath.localeCompare(b.registryPath)
        )

        return { remoteModels, currentModels }
      })(),
      timeoutPromise
    ])

    if (timedOut || !result) {
      Bare.exit(nonBlocking ? 0 : 1)
    }

    const { remoteModels, currentModels } = result
    const { added: rawAdded, removed: rawRemoved } = compareModels(remoteModels, currentModels)

    if (rawAdded.length === 0 && rawRemoved.length === 0) {
      console.log(`✅ Models are up to date (${remoteModels.length} models)`)
      Bare.exit(0)
    }

    const addedWithNames = assignNames(rawAdded)
    const { added, updated, removed } = separateUpdates(addedWithNames, rawRemoved)

    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    if (added.length > 0) {
      console.log(`✨ ${added.length} new model${added.length === 1 ? '' : 's'} available:`)
      added.slice(0, 10).forEach((m) => {
        console.log(`  + ${m.name} (${m.addon}, ${formatSize(m.expectedSize)})`)
      })
      if (added.length > 10) {
        console.log(`  ... and ${added.length - 10} more`)
      }
    }

    if (updated.length > 0) {
      console.log(`\n🔄 ${updated.length} model${updated.length === 1 ? '' : 's'} updated:`)
      updated.slice(0, 10).forEach((m) => {
        console.log(`  ~ ${m.name} (${m.addon}, ${formatSize(m.expectedSize)})`)
      })
      if (updated.length > 10) {
        console.log(`  ... and ${updated.length - 10} more`)
      }
    }

    if (removed.length > 0) {
      console.log(`\n⚠️  ${removed.length} model${removed.length === 1 ? '' : 's'} removed:`)
      removed.slice(0, 5).forEach((m) => {
        console.log(`  - ${m.name}`)
      })
      if (removed.length > 5) {
        console.log(`  ... and ${removed.length - 5} more`)
      }
    }

    console.log('')
    console.log(`💡 Run 'bun update-models' to sync changes`)
    console.log('')
    if (nonBlocking) {
      console.log('💡 Commit will proceed - update models when ready')
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('')

    Bare.exit(nonBlocking ? 0 : 1)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('❌ Model check failed:', message)
    Bare.exit(nonBlocking ? 0 : 1)
  }
}

async function updateModels(showDuplicates = false, noDedup = false): Promise<void> {
  console.log('🔄 Fetching models from QVAC Registry...\n')

  const currentModels = loadCurrentModels(OUTPUT_FILE)
  const models = await collectModels({ showDuplicates, noDedup })
  const { added, removed } = compareModels(models, currentModels)

  models.sort(
    (a, b) => a.addon.localeCompare(b.addon) || a.registryPath.localeCompare(b.registryPath)
  )

  fs.writeFileSync(OUTPUT_FILE, generateModelsFileContent(models))

  console.log(`✅ Generated ${models.length} models → ${OUTPUT_FILE}`)

  const addedWithNames = assignNames(added)

  if (added.length > 0 || removed.length > 0) {
    const historyFile = createHistoryFile(addedWithNames, removed, currentModels, HISTORY_DIR)
    if (historyFile) {
      const {
        added: trulyAdded,
        updated,
        removed: trulyRemoved
      } = separateUpdates(addedWithNames, removed)
      console.log(`📜 Created history file → ${historyFile}`)
      console.log(
        `   Added: ${trulyAdded.length}, Updated: ${updated.length}, Removed: ${trulyRemoved.length}`
      )
    }
  }
}

async function main(): Promise<void> {
  const CHECK_ONLY = Bare.argv.includes('--check')
  const NON_BLOCKING = Bare.argv.includes('--non-blocking')
  const SHOW_DUPLICATES = Bare.argv.includes('--show-duplicates')
  const NO_DEDUP = Bare.argv.includes('--no-dedup')

  if (CHECK_ONLY) {
    await checkOnly(NON_BLOCKING, SHOW_DUPLICATES)
  } else {
    await updateModels(SHOW_DUPLICATES, NO_DEDUP)
  }
}

main().catch(console.error)
