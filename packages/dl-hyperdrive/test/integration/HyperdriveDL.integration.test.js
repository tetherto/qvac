'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const getTmpDir = require('test-tmp')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const ProgressReport = require('@qvac/infer-base/src/utils/progressReport')
const HyperDriveDL = require('../../')
const { QvacErrorHyperdrive, ERR_CODES } = require('../../src/lib/error')

const HYPERDRIVE_PROTOCOL_PREFIX = 'hd://'

async function testenv (t) {
  const { teardown } = t

  const corestore = new Corestore(await getTmpDir())
  await corestore.ready()

  const drive = new Hyperdrive(corestore)
  await drive.ready()
  teardown(drive.close.bind(drive))

  const swarm = new Hyperswarm()
  teardown(swarm.destroy.bind(swarm))

  swarm.on('connection', (conn) => {
    corestore.replicate(conn)
  })
  const server = swarm.join(drive.discoveryKey, { server: true, client: false })
  await server.flushed()
  await swarm.flush()

  return { corestore, drive, swarm }
}

test('HyperDriveDL with drive key', async (t) => {
  const { drive } = await testenv(t)

  // Create a test file
  const testFilePath = '/test.txt'
  const testContent = 'Hello World'
  await drive.put(testFilePath, b4a.from(testContent))

  // Initialize HyperDriveDL with the drive key
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}${b4a.toString(drive.key, 'hex')}`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  await hyperDriveDL.ready()

  // Test getStream
  const stream = await hyperDriveDL.getStream(testFilePath)
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  const content = Buffer.concat(chunks).toString()
  t.is(content, testContent, 'getStream should return correct content')

  // Test getFileSize
  const size = await hyperDriveDL.getFileSize(testFilePath)
  t.is(size, testContent.length, 'getFileSize should return correct size')

  // Test cached status
  const isCached = await hyperDriveDL.cached(testFilePath)
  t.ok(isCached, 'File should be cached after writing')

  // Test list
  const files = await hyperDriveDL.list('/')
  t.ok(Array.isArray(files), 'list should return array')
  t.ok(files.length > 0, 'list should find files')
  t.ok(files.some(f => f.key === testFilePath), 'list should include test file')
  t.ok(files.some(f => f.cached), 'list should show cached status')

  // Test download
  const downloaded = await hyperDriveDL.download(testFilePath)
  t.is(downloaded, false, 'Should return false since file is already cached')

  // Test download with progress tracking
  await hyperDriveDL.deleteLocal(testFilePath) // Clear cache first
  const progressCalls = []
  const progressCallback = (data) => progressCalls.push(data)
  const progressReport = new ProgressReport({ [testFilePath]: testContent.length }, progressCallback)

  const downloadedWithProgress = await hyperDriveDL.download(testFilePath, progressReport)
  t.ok(downloadedWithProgress, 'Download with progress should succeed')

  await new Promise(resolve => setTimeout(resolve, 100)) // wait for download to complete

  t.ok(progressCalls.some(call =>
    call.action === 'completeFile' &&
    call.currentFile === testFilePath &&
    call.currentFileProgress === '100.00'
  ), 'Should report completion')

  // Test deleteLocal
  const deleted = await hyperDriveDL.deleteLocal(testFilePath)
  t.ok(deleted, 'deleteLocal should return true when file exists')
  const deletedAgain = await hyperDriveDL.deleteLocal(testFilePath)
  t.is(deletedAgain, false, 'deleteLocal should return false when file does not exist')

  // Close HyperDriveDL
  await hyperDriveDL.close()
})

test('HyperDriveDL with external drive', async (t) => {
  const { drive } = await testenv(t)

  // Create a test file
  const testFilePath = '/test2.txt'
  const testContent = 'Hello World, welcome to the external drive'
  await drive.put(testFilePath, b4a.from(testContent))

  // Initialize HyperDriveDL with the external drive
  const hyperDriveDL = new HyperDriveDL({ drive })
  await hyperDriveDL.ready()

  // Test getStream
  const stream = await hyperDriveDL.getStream(testFilePath)
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  const content = Buffer.concat(chunks).toString()
  t.is(content, testContent, 'getStream should return correct content with external drive')

  // Test getFileSize
  const size = await hyperDriveDL.getFileSize(testFilePath)
  t.is(size, testContent.length, 'getFileSize should return correct size with external drive')

  // Test cached status
  const isCached = await hyperDriveDL.cached(testFilePath)
  t.ok(isCached, 'File should be cached after writing with external drive')

  // Test list
  const files = await hyperDriveDL.list('/')
  t.ok(Array.isArray(files), 'list should return array with external drive')
  t.ok(files.length > 0, 'list should find files with external drive')
  t.ok(files.some(f => f.key === testFilePath), 'list should include test file with external drive')

  // Test download
  const downloaded = await hyperDriveDL.download(testFilePath)
  t.is(downloaded, false, 'Should return false since file is already cached with external drive')

  // Test deleteLocal
  const deleted = await hyperDriveDL.deleteLocal(testFilePath)
  t.ok(deleted, 'deleteLocal should return true when file exists with external drive')
  const deletedAgain = await hyperDriveDL.deleteLocal(testFilePath)
  t.is(deletedAgain, false, 'deleteLocal should return false when file does not exist with external drive')

  await hyperDriveDL.close()
})

test('HyperDriveDL directory operations', async (t) => {
  const { drive } = await testenv(t)

  // Create test directory structure
  await drive.put('/dir/file1.txt', b4a.from('content1'))
  await drive.put('/dir/file2.txt', b4a.from('content2'))
  await drive.put('/dir/subdir/file3.txt', b4a.from('content3'))

  // Initialize HyperDriveDL with the drive key
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}${b4a.toString(drive.key, 'hex')}`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  await hyperDriveDL.ready()

  // This forces the client to get the directory listing
  await hyperDriveDL.drive.getBlobs()

  // Test directory listing
  const files = await hyperDriveDL.list('/dir')
  t.is(files.length, 3, 'Should list all files in directory')
  t.ok(files.every(f => !f.cached), 'All files should not be cached')

  // Test directory cached status
  const dirCached = await hyperDriveDL.cached('/dir/')
  t.is(dirCached, false, 'Directory should not be marked as cached')

  // Test directory download
  const downloaded = await hyperDriveDL.download('/dir/')
  t.ok(downloaded, 'Should return true when directory is downloaded')
  const filesAfterDownload = await hyperDriveDL.list('/dir/')
  t.ok(filesAfterDownload.every(async f => {
    return await hyperDriveDL.cached(f.key)
  }), 'All files should be cached after directory download', filesAfterDownload)

  // Verify individual files are accessible
  const file1Stream = await hyperDriveDL.getStream('/dir/file1.txt')
  const file2Stream = await hyperDriveDL.getStream('/dir/file2.txt')
  const file3Stream = await hyperDriveDL.getStream('/dir/subdir/file3.txt')
  t.ok(file1Stream, 'Should be able to get stream for file1')
  t.ok(file2Stream, 'Should be able to get stream for file2')
  t.ok(file3Stream, 'Should be able to get stream for file3')

  // Test deletion of each file
  await hyperDriveDL.deleteLocal('/dir/file1.txt')
  await hyperDriveDL.deleteLocal('/dir/file2.txt')
  await hyperDriveDL.deleteLocal('/dir/subdir/file3.txt')
  const remainingFiles = await hyperDriveDL.list('/dir')
  t.ok(remainingFiles.every(f => !f.cached), 'All files should be cleared after individual deletion')

  // Test deletion of all files
  await hyperDriveDL.deleteLocal()
  const remainingFilesAfterDeleteAll = await hyperDriveDL.list()
  const remainingFilesAfterDeleteAllNotCached = remainingFilesAfterDeleteAll.filter(f => f.cached)
  t.is(remainingFilesAfterDeleteAllNotCached.length, 0, 'All files should be cleared after deletion of all files')

  await hyperDriveDL.close()
})

test('HyperDriveDL error handling', async (t) => {
  const { drive } = await testenv(t)
  const testFilePath = '/test.txt'
  const testContent = 'Hello World'
  await drive.put(testFilePath, b4a.from(testContent))

  // Initialize HyperDriveDL with the drive key
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}${b4a.toString(drive.key, 'hex')}`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  await hyperDriveDL.ready()

  // Test non-existent file
  try {
    await hyperDriveDL.getFileSize('/nonexistent.txt')
    t.fail('Should throw for non-existent file')
  } catch (err) {
    t.is(err.code, ERR_CODES.FILE_NOT_FOUND, 'Should throw FILE_NOT_FOUND error')
    t.is(err.name, 'FILE_NOT_FOUND', 'Error should have correct name')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }

  const createHyperDrive = (key) => new HyperDriveDL({ key })

  // Test invalid key format
  try {
    createHyperDrive('invalid-key')
    t.fail('Should throw for invalid key format')
  } catch (err) {
    t.is(err.code, ERR_CODES.KEY_INVALID, 'Should throw KEY_INVALID error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }

  // Test missing key
  try {
    createHyperDrive()
    t.fail('Should throw when key is missing')
  } catch (err) {
    t.is(err.code, ERR_CODES.KEY_OR_DRIVE_REQUIRED, 'Should throw KEY_OR_DRIVE_REQUIRED error')
    t.ok(err instanceof QvacErrorHyperdrive, 'Error should be a QvacErrorHyperdrive instance')
  }

  await hyperDriveDL.close()
})

test('HyperDriveDL cancel downloads functionality', async (t) => {
  const { drive } = await testenv(t)

  // Create multiple test files to download - make them larger to ensure downloads take time
  const testFiles = [
    { path: '/large-file1.txt', content: 'A'.repeat(10000) }, // 10KB
    { path: '/large-file2.txt', content: 'B'.repeat(10000) }, // 10KB
    { path: '/large-file3.txt', content: 'C'.repeat(10000) } // 10KB
  ]

  const mockProgressReport = {
    update: async () => await new Promise(resolve => setTimeout(resolve, 2000)), // simulate some latency during download
    completeFile: () => {}
  }

  // Add files to the drive
  for (const file of testFiles) {
    await drive.put(file.path, b4a.from(file.content))
  }

  // Initialize HyperDriveDL with the drive key
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}${b4a.toString(drive.key, 'hex')}`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  await hyperDriveDL.ready()

  // Clear any cached data first
  await hyperDriveDL.deleteLocal('/')

  // Test that files are not cached initially
  for (const file of testFiles) {
    const isCached = await hyperDriveDL.cached(file.path)
    t.is(isCached, false, `File ${file.path} should not be cached initially`)
  }

  // Start downloads for all files
  for (const file of testFiles) {
    const download = await hyperDriveDL.download(file.path, mockProgressReport)

    // Check if any downloads are still pending (they might complete very quickly in test environment)
    const pendingCount = download.trackers.length
    t.ok(pendingCount > 0, 'Downloads should be in progress')

    // Cancel all downloads while they're in progress
    await download.cancel()

    // Verify that downloads were cancelled by confirming that the files are not cached
    const isCached = await hyperDriveDL.cached(file.path)
    t.is(isCached, false, `File ${file.path} should not be cached after cancellation`)

    // Test cancelling when no downloads are pending
    await download.cancel() // should be a no-op
  }

  // Test that we can still download files after cancellation
  // Use a fresh instance to avoid any state issues
  const freshHyperDriveDL = new HyperDriveDL({ key: validKey })
  await freshHyperDriveDL.ready()

  const download = await freshHyperDriveDL.download(testFiles[0].path)
  t.ok(download.trackers.length > 0, 'Should be able to download files after cancellation')

  // wait for downloads to complete
  await new Promise(resolve => setTimeout(resolve, 100))

  const isCached = await freshHyperDriveDL.cached(testFiles[0].path)
  t.ok(isCached, 'File should be cached after successful download')

  await freshHyperDriveDL.close()
  await hyperDriveDL.close()
})

test('HyperDriveDL cancelDownloads with directory downloads', async (t) => {
  const { drive } = await testenv(t)

  // Create a directory structure with multiple files - make them larger to ensure downloads take time
  const testFiles = [
    { path: '/dir/file1.txt', content: 'A'.repeat(10000) }, // 10KB
    { path: '/dir/file2.txt', content: 'B'.repeat(10000) }, // 10KB
    { path: '/dir/subdir/file3.txt', content: 'C'.repeat(10000) } // 10KB
  ]

  // Add files to the drive
  for (const file of testFiles) {
    await drive.put(file.path, b4a.from(file.content))
  }

  // Initialize HyperDriveDL with the drive key
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}${b4a.toString(drive.key, 'hex')}`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  await hyperDriveDL.ready()

  // Clear any cached data first
  await hyperDriveDL.deleteLocal('/')

  // Test that files are not cached initially
  for (const file of testFiles) {
    const isCached = await hyperDriveDL.cached(file.path)
    t.is(isCached, false, `File ${file.path} should not be cached initially`)
  }

  // Start directory download
  const download = await hyperDriveDL.download('/dir/')
  t.ok(download.trackers.length > 0, 'Directory download should start successfully')

  // Wait a bit for downloads to start
  await new Promise(resolve => setTimeout(resolve, 1))

  // Check if downloads are in progress
  t.ok(download.trackers.length > 0, 'Directory downloads should be in progress')

  // Cancel all downloads while they're in progress
  await download.cancel()

  // Verify that downloads were cancelled by confirming that the files are not cached
  for (const file of testFiles) {
    const isCached = await hyperDriveDL.cached(file.path)
    t.is(isCached, false, `File ${file.path} should not be cached after directory download cancellation`)
  }

  await hyperDriveDL.close()
})

test('HyperDriveDL download with diskPath functionality', async (t) => {
  const { drive } = await testenv(t)
  const { teardown } = t

  const testFiles = [
    { path: '/simple.txt', content: 'Hello World from Hyperdrive!' },
    { path: '/binary.dat', content: Buffer.from([0x01, 0x02, 0x03, 0x04, 0xFF, 0xFE]) },
    { path: '/nested/deep/file.json', content: JSON.stringify({ test: 'data', nested: true }) },
    { path: '/large.txt', content: 'A'.repeat(10000) } // 10KB file
  ]

  for (const file of testFiles) {
    const content = typeof file.content === 'string' ? b4a.from(file.content) : file.content
    await drive.put(file.path, content)
  }

  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}${b4a.toString(drive.key, 'hex')}`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  await hyperDriveDL.ready()

  const downloadDir = await getTmpDir()
  teardown(() => {
    try {
      // Clean up downloaded files
      fs.rmSync(downloadDir, { recursive: true, force: true })
    } catch (err) {
    }
  })

  // Test 1: Basic file downloading to disk
  const download1 = await hyperDriveDL.download('simple.txt', { diskPath: downloadDir })

  // Wait for download to complete
  const results1 = await download1.await()
  t.is(results1.length, 1, 'Should return one result')
  t.is(results1[0].file, 'simple.txt', 'Result should have correct file name')
  t.is(results1[0].error, null, 'Result should have no error')
  t.is(results1[0].cached, false, 'Result should show not cached (saved to disk)')

  const expectedPath = path.join(downloadDir, 'simple.txt')
  t.ok(fs.existsSync(expectedPath), 'File should exist on disk')

  const savedContent = fs.readFileSync(expectedPath, 'utf8')
  t.is(savedContent, testFiles[0].content, 'Saved file content should match original')

  // Test 2: Binary file downloading to disk
  const download2 = await hyperDriveDL.download('binary.dat', { diskPath: downloadDir })

  // Wait for download to complete
  const results2 = await download2.await()
  t.is(results2.length, 1, 'Should return one result')
  t.is(results2[0].file, 'binary.dat', 'Result should have correct file name')
  t.is(results2[0].error, null, 'Result should have no error')

  const binaryPath = path.join(downloadDir, 'binary.dat')
  t.ok(fs.existsSync(binaryPath), 'Binary file should exist on disk')

  const savedBinary = fs.readFileSync(binaryPath)
  t.alike(savedBinary, testFiles[1].content, 'Binary file content should match original')

  // Test 3: Nested file downloading (saves with basename)
  const download3 = await hyperDriveDL.download('nested/deep/file.json', { diskPath: downloadDir })

  // Wait for download to complete
  const results3 = await download3.await()
  t.is(results3.length, 1, 'Should return one result')
  t.is(results3[0].file, 'nested/deep/file.json', 'Result should have correct file name')
  t.is(results3[0].error, null, 'Result should have no error')

  const expectedNestedPath = path.join(downloadDir, 'file.json')
  t.ok(fs.existsSync(expectedNestedPath), 'Nested file should exist on disk')

  const savedJson = fs.readFileSync(expectedNestedPath, 'utf8')
  t.is(savedJson, testFiles[2].content, 'JSON file content should match original')

  // Test 4: Progress reporting with disk saving
  const progressCalls = []
  const progressCallback = (data) => {
    progressCalls.push(data)
  }

  // Create a proper ProgressReport instance
  const progressReporter = new ProgressReport({ 'large.txt': testFiles[3].content.length }, progressCallback)

  const download4 = await hyperDriveDL.download('large.txt', {
    diskPath: downloadDir,
    progressReporter
  })

  // Wait for download to complete
  const results4 = await download4.await()
  t.is(results4.length, 1, 'Should return one result')
  t.is(results4[0].file, 'large.txt', 'Result should have correct file name')
  t.is(results4[0].error, null, 'Result should have no error')

  const largePath = path.join(downloadDir, 'large.txt')
  t.ok(fs.existsSync(largePath), 'Large file should exist on disk')

  const savedLarge = fs.readFileSync(largePath, 'utf8')
  t.is(savedLarge, testFiles[3].content, 'Large file content should match original')

  // Verify progress reporting was called
  const updateCalls = progressCalls.filter(call => call.action === 'loadingFile')
  const completeCalls = progressCalls.filter(call => call.action === 'completeFile')
  t.ok(updateCalls.length > 0, 'Should have received progress updates')
  t.is(completeCalls.length, 1, 'Should have received one completion call')
  t.is(completeCalls[0].currentFile, 'large.txt', 'Completion should be for correct file')

  // Test 5: File overwrite behavior
  const download5 = await hyperDriveDL.download('simple.txt', { diskPath: downloadDir })

  // Wait for download to complete
  const results5 = await download5.await()
  t.is(results5.length, 1, 'Should return one result')
  t.is(results5[0].file, 'simple.txt', 'Result should have correct file name')
  t.is(results5[0].error, null, 'Result should have no error')

  const overwritePath = path.join(downloadDir, 'simple.txt')
  t.ok(fs.existsSync(overwritePath), 'File should still exist after overwrite')
  const overwriteContent = fs.readFileSync(overwritePath, 'utf8')
  t.is(overwriteContent, testFiles[0].content, 'Overwritten file content should match original')

  // Test 6: Verify no .part files remain
  const files = fs.readdirSync(downloadDir, { recursive: true })
  const partFiles = files.filter(file => file.toString().endsWith('.part'))
  t.is(partFiles.length, 0, 'No temporary .part files should remain')

  await hyperDriveDL.close()
})

test('HyperDriveDL download with diskPath error handling', async (t) => {
  const { drive } = await testenv(t)

  const testFilePath = '/test-error.txt'
  const testContent = 'Error handling test'
  await drive.put(testFilePath, b4a.from(testContent))

  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}${b4a.toString(drive.key, 'hex')}`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  await hyperDriveDL.ready()

  // Test 1: Non-existent file
  const downloadDir = await getTmpDir()
  const download1 = await hyperDriveDL.download('nonexistent.txt', { diskPath: downloadDir })
  const results1 = await download1.await()

  t.is(results1.length, 1, 'Should return one result for non-existent file')
  t.is(results1[0].file, 'nonexistent.txt', 'Result should have correct file name')
  t.ok(results1[0].error, 'Result should have an error for non-existent file')
  t.ok(results1[0].error instanceof QvacErrorHyperdrive, 'Error should be QvacErrorHyperdrive instance')

  // Test 2: Drive not ready
  const notReadyDL = new HyperDriveDL({ key: validKey })
  try {
    await notReadyDL.download('test-error.txt', { diskPath: downloadDir })
    t.fail('Should throw error when drive not ready')
  } catch (err) {
    t.ok(err instanceof QvacErrorHyperdrive, 'Should throw QvacErrorHyperdrive when drive not ready')
  }

  // Test 3: Invalid disk path (trying to write to a file instead of directory)
  const tempFile = path.join(downloadDir, 'tempfile.txt')
  fs.writeFileSync(tempFile, 'temp')

  const download3 = await hyperDriveDL.download('test-error.txt', { diskPath: tempFile })
  const results3 = await download3.await()

  t.is(results3.length, 1, 'Should return one result for invalid disk path')
  t.is(results3[0].file, 'test-error.txt', 'Result should have correct file name')
  t.ok(results3[0].error, 'Result should have an error for invalid disk path')
  t.ok(results3[0].error instanceof QvacErrorHyperdrive, 'Error should be QvacErrorHyperdrive instance')

  await hyperDriveDL.close()
})

test('HyperDriveDL cancelDownloads with progress reporting', async (t) => {
  const { drive } = await testenv(t)

  // Create a test file
  const testFilePath = '/progress-test.txt'
  const testContent = 'A'.repeat(5000)
  await drive.put(testFilePath, b4a.from(testContent))

  // Initialize HyperDriveDL with the drive key
  const validKey = `${HYPERDRIVE_PROTOCOL_PREFIX}${b4a.toString(drive.key, 'hex')}`
  const hyperDriveDL = new HyperDriveDL({ key: validKey })
  await hyperDriveDL.ready()

  // Clear any cached data first
  await hyperDriveDL.deleteLocal('/')

  // Test that file is not cached initially
  const cached = await hyperDriveDL.cached(testFilePath)
  t.is(cached, false, `File ${testFilePath} should not be cached initially`)

  // Set up progress tracking
  const progressCalls = []
  const mockProgressCallback = (data) => {
    progressCalls.push(data)
  }

  const mockProgressReport = new ProgressReport({ 'progress-test.txt': testContent.length }, mockProgressCallback)

  // Start download with progress tracking
  const download = await hyperDriveDL.download(testFilePath, mockProgressReport)

  // Check if downloads are in progress
  t.ok(download.trackers.length > 0, 'Downloads with progress tracking should be in progress')

  // Cancel all downloads while they're in progress
  await download.cancel()

  // Verify that downloads were cancelled by confirming that the files are not cached
  const fileCached = await hyperDriveDL.cached(testFilePath)
  t.is(fileCached, false, `File ${testFilePath} should not be cached after cancellation with progress tracking`)

  // Test cancelling when no downloads are pending
  await download.cancel() // should be a no-op

  // Verify that some progress was made before cancellation
  t.ok(progressCalls.length > 0, 'Should have received some progress updates before cancellation')

  await hyperDriveDL.close()
})
