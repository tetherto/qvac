// Opens (or creates) an on-disk Corestore at the given directory and closes it.
// Run twice in separate processes to reproduce #5407: the second open runs the
// device-file check against the CORESTORE file the first one wrote.
const fs = require('bare-fs')
const path = require('bare-path')
const Corestore = require('corestore')

const dir = Bare.argv[2]
const step = Bare.argv[3] || 'open'

function findDeviceFile(root) {
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      const found = findDeviceFile(full)
      if (found) return found
    } else if (name === 'CORESTORE') {
      return full
    }
  }
  return null
}

function logStat(label) {
  const file = fs.existsSync(dir) ? findDeviceFile(dir) : null
  if (!file) return console.log(`[${step}] ${label}: no CORESTORE file yet`)
  const st = fs.statSync(file)
  console.log(
    `[${step}] ${label}: ${JSON.stringify({
      ino: String(st.ino),
      mtime: st.mtime.getTime(),
      birthtime: st.birthtime.getTime(),
      now: Date.now(),
      content: fs.readFileSync(file, 'utf8').replace(/\n/g, ' | ')
    })}`
  )
}

async function main() {
  logStat('before open')
  const store = new Corestore(dir)
  await store.ready()
  await store.close()
  // Windows keeps CORESTORE locked while the store is open, so read it after close.
  logStat('after close')
  console.log(`[${step}] ok`)
}

main().catch((err) => {
  console.error(`[${step}] failed: ${err.code || ''} ${err.message}`)
  Bare.exitCode = 1
})
