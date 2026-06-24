'use strict'

const HyperDriveDL = require('..')
const fs = require('bare-fs')
const path = require('bare-path')

const HYPERDRIVE_KEY = 'hd://yourhyperdrivekey'
const TARGET_DIR = 'target'

async function ensureTargetDirExists (dir) {
  try {
    const stat = await fs.promises.stat(dir)
    if (!stat.isDirectory()) {
      throw new Error(`${dir} exists but is not a directory`)
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`Creating target directory: ${dir}`)
      await fs.promises.mkdir(dir, { recursive: true })
    } else {
      throw err
    }
  }
}

async function listAndLoadFiles () {
  const hyperdriveDL = new HyperDriveDL({
    key: HYPERDRIVE_KEY
  })

  await hyperdriveDL.ready()

  // Ensure the target directory exists
  await ensureTargetDirExists(TARGET_DIR)

  const fileList = await hyperdriveDL.list()

  console.log({ fileList })

  for await (const file of fileList) {
    const filePath = path.join(TARGET_DIR, file)

    console.log(`Downloading file: ${file}`)

    // Create a writable stream to the target file
    const writeStream = fs.createWriteStream(filePath)

    // Fetch the readable stream from HyperDrive
    const readStream = await hyperdriveDL.getStream(file)

    for await (const chunk of readStream) {
      writeStream.write(chunk)
    }

    writeStream.end()

    console.log(`File saved: ${filePath}`)
  }

  await hyperdriveDL.close()

  console.log('connection finished')
}

listAndLoadFiles().catch(console.error)
