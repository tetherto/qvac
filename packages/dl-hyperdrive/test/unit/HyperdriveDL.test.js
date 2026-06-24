'use strict'

const test = require('brittle')
const ProgressReport = require('@qvac/infer-base/src/utils/progressReport')
const HyperDriveDL = require('../../')
const { QvacErrorHyperdrive, ERR_CODES } = require('../../src/lib/error')

const HYPERDRIVE_PROTOCOL_PREFIX = 'hd://'

test('Constructor - Valid Hyperdrive Key', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`

  t.execution(
    () => new HyperDriveDL({ key: validKey }),
    'Should not throw with a valid key'
  )
  t.pass('Constructor initialized with valid key')
})

test('Constructor - Invalid Hyperdrive Key', async (t) => {
  const invalidKey = 'invalid://abcdef1234567890'

  const createHyperDrive = () => new HyperDriveDL({ key: invalidKey })
  try {
    createHyperDrive()
    t.fail('Should throw error for invalid protocol')
  } catch (err) {
    t.is(err.code, ERR_CODES.KEY_INVALID, 'Should throw KEY_INVALID error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }
})

test('Constructor - Missing Key', async (t) => {
  const createHyperDrive = () => new HyperDriveDL({})
  try {
    createHyperDrive()
    t.fail('Should throw error for missing key')
  } catch (err) {
    t.is(err.code, ERR_CODES.KEY_OR_DRIVE_REQUIRED, 'Should throw KEY_OR_DRIVE_REQUIRED error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }
})

test('Constructor - Direct Drive Usage', async (t) => {
  const mockDrive = {
    createReadStream: () => { },
    has: () => { },
    entry: () => { },
    list: () => { },
    clear: () => { },
    clearAll: () => { }
  }

  t.execution(
    () => new HyperDriveDL({ drive: mockDrive }),
    'Should not throw when only drive is provided'
  )

  t.exception(
    () => new HyperDriveDL({}),
    /KEY_OR_DRIVE_REQUIRED/,
    'Should throw error when neither key nor drive is provided'
  )
})

test('Stream Handling - Get Stream', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/path'

  let calledPath = null
  hyperDriveDL.drive = {
    download: () => { },
    createReadStream: (p) => {
      calledPath = p
      return 'stream'
    }
  }

  const stream = await hyperDriveDL.getStream(path)

  t.is(calledPath, path, 'createReadStream should be called with correct path')
  t.is(stream, 'stream', 'Should return the correct stream')
})

test('Stream Handling - Error on Get Stream', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/invalid/path'

  hyperDriveDL.drive = {
    createReadStream: () => {
      throw new QvacErrorHyperdrive({ code: ERR_CODES.FILE_NOT_FOUND, adds: path })
    }
  }

  try {
    await hyperDriveDL.getStream(path)
    t.fail('Should throw an error on invalid path')
  } catch (err) {
    t.is(err.code, ERR_CODES.FILE_NOT_FOUND, 'Should throw FILE_NOT_FOUND error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }
})

test('Cache Handling - Check File Cache Status', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  hyperDriveDL.drive = {
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          blockLength: 100
        }
      }
    }),
    has: async () => true
  }

  const isCached = await hyperDriveDL.cached(path)
  t.ok(isCached, 'Should return true for cached file')

  hyperDriveDL.drive.has = async () => false
  const isNotCached = await hyperDriveDL.cached(path)
  t.not(isNotCached, 'Should return false for non-cached file')
})

test('Cache Handling - Check Directory Cache Status', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/'

  hyperDriveDL.drive = { has: async () => true }

  const allCached = await hyperDriveDL.cached(path)
  t.ok(allCached, 'Should return true when all files are cached')

  hyperDriveDL.drive = { has: async () => false }

  const notAllCached = await hyperDriveDL.cached(path)
  t.not(notAllCached, 'Should return false when not all files are cached')
})

test('Download Handling', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  let downloadCalled = false
  let hasCallCount = 0

  hyperDriveDL.cached = async () => false
  hyperDriveDL.drive = {
    download: (p) => {
      downloadCalled = true
      return {
        done: async () => await new Promise(resolve => setTimeout(resolve, 20)),
        destroy: async () => await new Promise(resolve => setTimeout(resolve, 20))
      }
    },
    entry: async () => ({
      value: {
        blob: {
          blockLength: 1000
        }
      }
    }),
    getBlobs: async () => ({
      core: {
        has: async () => {
          hasCallCount++
          return hasCallCount > 2 // Only return true after a couple of calls
        }
      }
    })
  }

  const download = await hyperDriveDL.download(path)
  t.ok(Array.isArray(download.trackers), 'Should return array of trackers')
  t.ok(download.trackers.length > 0, 'Should return at least one tracker')

  // Wait for the async downloadStart to complete
  await new Promise(resolve => setTimeout(resolve, 150))
  t.ok(downloadCalled, 'Download should be called')

  hyperDriveDL.cached = async () => true
  const notDownloaded = await hyperDriveDL.download(path)
  t.is(notDownloaded, false, 'Should return false when file is already cached')

  // Test with progress tracking
  const progressCalls = []
  const progressReport = new ProgressReport({ [path]: 100 }, (data) => progressCalls.push(data))

  hyperDriveDL.cached = async () => false

  const downloadWithProgress = await hyperDriveDL.download(path, progressReport)
  t.ok(Array.isArray(downloadWithProgress.trackers), 'Should return array of trackers with progress')

  // Wait a bit for the async operations to complete
  await new Promise(resolve => setTimeout(resolve, 200))

  t.ok(progressCalls.some(call => call.action === 'loadingFile'), 'Should report progress updates')
  t.ok(progressCalls.some(call => call.action === 'completeFile'), 'Should report file completion')
})

test('Download Progress Tracking', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  let hasCallCount = 0
  hyperDriveDL.drive = {
    download: () => ({ done: async () => { await new Promise(resolve => setTimeout(resolve, 20)) } }),
    has: async () => false,
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          byteOffset: 0,
          byteLength: 100,
          blockLength: 4
        }
      }
    }),
    getBlobs: async () => ({
      core: {
        has: async () => {
          hasCallCount++
          return hasCallCount === 2 // Return true only on second call
        }
      }
    })
  }

  const progressCalls = []
  const progressReport = new ProgressReport({ [path]: 100 }, (data) => progressCalls.push(data))

  const downloadWithProgress = await hyperDriveDL.download(path, progressReport)
  t.ok(Array.isArray(downloadWithProgress.trackers), 'Should return array of trackers')

  // Wait a bit for the async operations to complete
  await new Promise(resolve => setTimeout(resolve, 200))

  t.ok(progressCalls.some(call =>
    call.action === 'loadingFile' &&
    call.currentFile === path &&
    call.currentFileProgress === '0.00'
  ), 'Should report 0% progress')

  t.ok(progressCalls.some(call =>
    call.action === 'loadingFile' &&
    call.currentFile === path &&
    call.currentFileProgress === '25.00'
  ), 'Should report 25% progress')

  t.ok(progressCalls.some(call =>
    call.action === 'completeFile' &&
    call.currentFile === path &&
    call.currentFileProgress === '100.00'
  ), 'Should report 100% progress')
})

test('Delete Local Handling', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  let clearPath = null
  let clearAllCalled = false

  hyperDriveDL.drive = {
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          blockLength: 100
        }
      }
    }),
    has: async () => true,
    clear: async (p) => {
      clearPath = p
      return { blocks: 1 }
    },
    clearAll: async () => {
      clearAllCalled = true
      return { blocks: 1 }
    }
  }

  const deleted = await hyperDriveDL.deleteLocal(path)
  t.ok(deleted, 'Should return true when file is deleted')
  t.is(clearPath, path, 'Clear should be called with correct path')

  const deletedAll = await hyperDriveDL.deleteLocal()
  t.ok(deletedAll, 'Should return true when all files are deleted')
  t.ok(clearAllCalled, 'ClearAll should be called')

  hyperDriveDL.drive.clear = async () => null
  const notDeleted = await hyperDriveDL.deleteLocal(path)
  t.not(notDeleted, 'Should return false when no file is found')
})

test('Download Cancellation - Individual Tracker', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  let downloadDestroyed = false
  hyperDriveDL.cached = async () => false
  hyperDriveDL.drive = {
    download: () => {
      return {
        done: async () => { await new Promise(resolve => setTimeout(resolve, 100)) },
        destroy: () => { downloadDestroyed = true }
      }
    },
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          blockLength: 4,
          byteLength: 100
        }
      }
    }),
    getBlobs: async () => ({
      core: {
        has: async () => false
      }
    })
  }

  const download = await hyperDriveDL.download(path)
  t.ok(Array.isArray(download.trackers), 'Should return array of trackers')
  t.ok(download.trackers.length > 0, 'Should return at least one tracker')

  await new Promise(resolve => setTimeout(resolve, 10))

  // Cancel the download
  await download.cancel()
  t.ok(downloadDestroyed, 'Download should be destroyed when cancelled')

  // Test cancelling the same tracker again (should be no-op)
  await download.cancel()
  t.pass('Cancelling already cancelled tracker should not throw')
})

test('Download Cancellation - Multiple Trackers', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/directory/'

  let destroyedCount = 0
  hyperDriveDL.cached = async () => false
  hyperDriveDL.drive = {
    download: () => {
      return {
        done: async () => { await new Promise(resolve => setTimeout(resolve, 100)) },
        destroy: () => { destroyedCount++ }
      }
    },
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          blockLength: 4,
          byteLength: 100
        }
      }
    }),
    getBlobs: async () => ({
      core: {
        has: async () => false
      }
    }),
    list: () => [
      { key: '/test/directory/file1.txt' },
      { key: '/test/directory/file2.txt' },
      { key: '/test/directory/file3.txt' }
    ]
  }

  const download = await hyperDriveDL.download(path)
  t.ok(Array.isArray(download.trackers), 'Should return array of trackers')
  t.ok(download.trackers.length > 1, 'Should return multiple trackers for directory')

  await new Promise(resolve => setTimeout(resolve, 200))

  // Cancel the download
  await download.cancel()

  t.is(destroyedCount, download.trackers.length, 'All downloads should be destroyed when cancelled')
})

test('Download Cancellation - During Active Download', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  let downloadStarted = false
  let downloadDestroyed = false
  const progressCalls = []

  hyperDriveDL.cached = async () => false
  hyperDriveDL.drive = {
    download: () => {
      downloadStarted = true
      return {
        done: async () => {
          await new Promise(resolve => setTimeout(resolve, 200))
        },
        destroy: () => { downloadDestroyed = true }
      }
    },
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          blockLength: 4,
          byteLength: 100
        }
      }
    }),
    getBlobs: async () => ({
      core: {
        has: async () => false
      }
    })
  }

  const mockProgressReport = {
    update: (file, bytes) => {
      progressCalls.push({ action: 'update', file, bytes })
    },
    completeFile: (file) => {
      progressCalls.push({ action: 'completeFile', file })
    }
  }

  const download = await hyperDriveDL.download(path, mockProgressReport)
  await new Promise(resolve => setTimeout(resolve, 100))
  t.ok(downloadStarted, 'Download should have started')

  // Wait a bit for download to be active, then cancel
  await new Promise(resolve => setTimeout(resolve, 50))
  await download.cancel()

  t.ok(downloadDestroyed, 'Download should be destroyed when cancelled during active download')

  const completeFileCalls = progressCalls.filter(call => call.action === 'completeFile')
  t.is(completeFileCalls.length, 0, 'No completeFile callback should be called after cancellation')
})

test('Download Cancellation - Error Handling', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  hyperDriveDL.cached = async () => false
  hyperDriveDL.drive = {
    download: () => {
      return {
        done: async () => { await new Promise(resolve => setTimeout(resolve, 100)) },
        destroy: () => { throw new Error('Destroy failed') }
      }
    },
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          blockLength: 4,
          byteLength: 100
        }
      }
    }),
    getBlobs: async () => ({
      core: {
        has: async () => false
      }
    })
  }

  const download = await hyperDriveDL.download(path)
  t.ok(Array.isArray(download.trackers), 'Should return array of trackers')

  await new Promise(resolve => setTimeout(resolve, 200))

  // Test that cancellation errors are handled gracefully
  await t.exception(
    async () => await download.cancel(),
    /Destroy failed/,
    'Should throw error when destroy fails'
  )
})

test('Download Cancellation - No Download Object', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  hyperDriveDL.cached = async () => false
  hyperDriveDL.drive = {
    download: () => null, // Return null to simulate no download object
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          blockLength: 4,
          byteLength: 100
        }
      }
    }),
    getBlobs: async () => ({
      core: {
        has: async () => false
      }
    })
  }

  const download = await hyperDriveDL.download(path)
  t.ok(Array.isArray(download.trackers), 'Should return array of trackers')

  // Test that cancellation handles null download gracefully
  await download.cancel()
  t.pass('Cancelling tracker with null download should not throw')
})

test('Download Cancellation - After Completion', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  hyperDriveDL.cached = async () => false
  hyperDriveDL.drive = {
    download: () => {
      return {
        done: async () => { await new Promise(resolve => setTimeout(resolve, 50)) },
        destroy: () => { /* No-op for this test */ }
      }
    },
    entry: async () => ({
      value: {
        blob: {
          blockOffset: 0,
          blockLength: 4,
          byteLength: 100
        }
      }
    }),
    getBlobs: async () => ({
      core: {
        has: async () => true // All blocks already available
      }
    })
  }

  const download = await hyperDriveDL.download(path)
  t.ok(Array.isArray(download.trackers), 'Should return array of trackers')

  // Wait for download to complete
  await new Promise(resolve => setTimeout(resolve, 100))

  // Try to cancel after completion
  await download.cancel()
  t.pass('Cancelling completed download should not throw')
})

test('_checkDrive - Error When Drive Not Ready', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })

  hyperDriveDL.drive = null

  try {
    hyperDriveDL._checkDrive()
    t.fail('Should throw error when drive is not ready')
  } catch (err) {
    t.is(err.code, ERR_CODES.DRIVE_NOT_READY, 'Should throw DRIVE_NOT_READY error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }
})

test('getFileSize - Error on Missing Entry', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  hyperDriveDL.drive = {
    entry: async () => ({ value: {} }) // Missing blob property
  }

  try {
    await hyperDriveDL.getFileSize(path)
    t.fail('Should throw error when blob is missing')
  } catch (err) {
    t.is(err.code, ERR_CODES.FILE_NOT_FOUND, 'Should throw FILE_NOT_FOUND error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }
})

test('getFileSize - Error When Drive Not Ready', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/file.txt'

  hyperDriveDL.drive = null

  try {
    await hyperDriveDL.getFileSize(path)
    t.fail('Should throw error when drive is not ready')
  } catch (err) {
    t.is(err.code, ERR_CODES.DRIVE_NOT_READY, 'Should throw DRIVE_NOT_READY error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }
})

test('list - Error on Connection Failure', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  const path = '/test/'

  hyperDriveDL.drive = {
    list: () => {
      throw new Error('Network error')
    }
  }

  try {
    await hyperDriveDL.list(path)
    t.fail('Should throw error on connection failure')
  } catch (err) {
    t.is(err.code, ERR_CODES.CONNECTION_FAILED, 'Should throw CONNECTION_FAILED error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }
})

test('_validateAndDecodeKey - Error on Invalid Key Format', async (t) => {
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}abcdef1234567890abcdef1234567890`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })

  try {
    hyperDriveDL._validateAndDecodeKey('invalid-key-format')
    t.fail('Should throw error for invalid key format')
  } catch (err) {
    t.is(err.code, ERR_CODES.KEY_INVALID, 'Should throw KEY_INVALID error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }
})
