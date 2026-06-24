'use strict'

const HyperDriveDL = require('../index.js')

/**
 * Example demonstrating download cancellation functionality
 * This example shows how to cancel downloads after a certain time period
 */
async function cancelDownloadsExample () {
  console.log('Starting download cancellation example...\n')

  // Basic cancellation with timeout
  console.log('=== Basic cancellation with timeout ===')
  await basicCancellationWithTimeout()

  console.log('\nExample completed!')
}

/**
 * Basic cancellation with timeout
 * Shows how to cancel downloads after a certain time period
 */
async function basicCancellationWithTimeout () {
  console.level = 'debug'
  const dl = new HyperDriveDL({
    key: 'hd://5dca3a0ca4ffe4686da0c4163b15b52be07a6676be66d1b4fb0fd9fc7aad583c',
    logger: console
  })

  try {
    await dl.ready()
    console.log('Getting list of available files...')

    // Get list of files that can be downloaded
    const files = await dl.list('/')
    console.log(`Found ${files.length} files available for download`)

    if (files.length === 0) {
      console.log('No files found to download')
      return
    }

    // Show first few files
    const sampleFiles = files.slice(0, 3)
    console.log('Sample files:', sampleFiles.map(f => f.key))

    // Start downloading the first few files
    const filesToDownload = files.slice(0, 3).map(f => f.key)
    console.log('Starting downloads for:', filesToDownload)

    // Store all downloads for cancellation
    const allDownloads = []

    for (const file of filesToDownload) {
      const download = await dl.download(file)
      console.log(`Download started for ${file}: got ${download.trackers.length} trackers`)
      allDownloads.push(download)
    }

    // Set a timeout to cancel downloads after 100ms
    setTimeout(async () => {
      console.log('Timeout reached, cancelling downloads...')

      // Cancel all downloads
      try {
        for (const download of allDownloads) {
          await download.cancel()
        }
        console.log('Download cancelled successfully')
      } catch (error) {
        console.log('Error cancelling download:', error.message)
      }

      console.log('Downloads cancelled successfully')

      // check that the files are not cached
      for (const file of filesToDownload) {
        const isCached = await dl.cached(file)
        console.log(`File ${file} is cached: ${isCached}`)
      }
    }, 100)

    // Wait a bit to see the cancellation in action
    await new Promise(resolve => setTimeout(resolve, 200))

    // try cancelling downloads again (should be no-op since already cancelled)
    for (const download of allDownloads) {
      try {
        await download.cancel()
        console.log('Successfully cancelled already-cancelled download (no-op)')
      } catch (error) {
        console.log('Error cancelling already-cancelled download:', error.message)
      }
    }

    // delete local files
    for (const file of filesToDownload) {
      await dl.deleteLocal(file)
    }

    // wait for downloads to complete - try downloading some new files
    console.log('Starting fresh downloads for directory "/"')

    const download = await dl.download('/')
    console.log(`Complete directory download started: got ${download.trackers.length} trackers`)

    await new Promise(resolve => setTimeout(resolve, 1000))

    // try to cancel completed downloads
    await download.cancel()
    console.log('Successfully cancelled completed download (no-op)')

    console.log('Downloads cancelled successfully')
  } catch (error) {
    console.error('Error in basic cancellation example:', error.message)
  } finally {
    await dl.close()
  }
}

cancelDownloadsExample().catch(console.error)
