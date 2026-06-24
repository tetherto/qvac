'use strict'

const Hyperswarm = require('hyperswarm')
const Hyperdrive = require('hyperdrive')
const Localdrive = require('localdrive')
const Corestore = require('corestore')
const path = require('bare-path')
const debounce = require('debounceify')
const process = require('bare-process')
const b4a = require('b4a')
const getTmpDir = require('test-tmp')

async function main () {
  const folderPath = process.argv[2]

  if (!folderPath) {
    console.error('Error: Please provide a folder path as an argument.')
    process.exit(1)
  }

  const absoluteFolderPath = path.resolve(folderPath)

  const store = new Corestore(await getTmpDir())
  const swarm = new Hyperswarm()

  const local = new Localdrive(absoluteFolderPath)

  const drive = new Hyperdrive(store)

  await drive.ready()

  const mirrorDrive = debounce(async () => {
    console.log(
      `Started mirroring changes from '${absoluteFolderPath}' into the drive...`
    )
    const mirror = local.mirror(drive)
    await mirror.done()
    console.log('Finished mirroring:', mirror.count)
  })

  await mirrorDrive()

  swarm.on('connection', conn => {
    store.replicate(conn)
    console.log('New Connection: ' + b4a.toString(conn.publicKey, 'hex'))
  })

  const discovery = swarm.join(drive.discoveryKey)
  await discovery.flushed()

  console.log('Hyperdrive key:', 'hd://' + b4a.toString(drive.key, 'hex'))
}

main().catch(console.error)
