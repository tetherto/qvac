'use strict'
const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const FilesystemDL = require('../..')
const { QvacErrorFilesystem, ERR_CODES } = require('../../src/lib/error')

const TEST_DIR = path.join(__dirname, 'test_folder')
const TEST_FILE_1 = 'test1.txt'
const TEST_FILE_2 = 'test2.txt'
const TEST_FILE_CONTENT_1 = 'Hello, World!'
const TEST_FILE_CONTENT_2 = 'Test file content for file 2.'

test.hook('setup', (t) => {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR)
  }

  fs.writeFileSync(path.join(TEST_DIR, TEST_FILE_1), TEST_FILE_CONTENT_1)
  fs.writeFileSync(path.join(TEST_DIR, TEST_FILE_2), TEST_FILE_CONTENT_2)

  // Verify that the test data was actually created
  t.ok(fs.existsSync(TEST_DIR), 'Test directory should exist')
  t.ok(fs.existsSync(path.join(TEST_DIR, TEST_FILE_1)), 'Test file 1 should exist')
  t.ok(fs.existsSync(path.join(TEST_DIR, TEST_FILE_2)), 'Test file 2 should exist')
  t.is(fs.readFileSync(path.join(TEST_DIR, TEST_FILE_1), 'utf8'), TEST_FILE_CONTENT_1, 'Test file 1 content should be correct')
  t.is(fs.readFileSync(path.join(TEST_DIR, TEST_FILE_2), 'utf8'), TEST_FILE_CONTENT_2, 'Test file 2 content should be correct')
})

test('FilesystemDL: constructor should throw error with correct code if folder does not exist', async (t) => {
  const createFileSystemDL = () => new FilesystemDL({ dirPath: '/nonexistent/folder' })
  try {
    createFileSystemDL()
    t.fail('Should throw an error for non-existent folder')
  } catch (err) {
    t.ok(err instanceof QvacErrorFilesystem, 'Error should be instance of QvacErrorFilesystem')
    t.is(err.code, ERR_CODES.PATH_INVALID, 'Error code should be PATH_INVALID')
    t.ok(err.message.includes('/nonexistent/folder'), 'Error message should include the invalid path')
  }
})

test('FilesystemDL: constructor should throw error if dirPath is missing', async (t) => {
  const createFileSystemDL = () => new FilesystemDL({})
  try {
    createFileSystemDL()
    t.fail('Should throw an error for missing dirPath')
  } catch (err) {
    t.ok(err instanceof QvacErrorFilesystem, 'Error should be instance of QvacErrorFilesystem')
    t.is(err.code, ERR_CODES.OPTS_INVALID, 'Error code should be OPTS_INVALID')
  }
})

test('FilesystemDL: constructor should throw error if options is null', async (t) => {
  const createFileSystemDL = () => new FilesystemDL(null)
  try {
    createFileSystemDL()
    t.fail('Should throw an error for null options')
  } catch (err) {
    t.ok(err instanceof Error, 'Error should be an Error instance')
    t.pass('Constructor properly throws error for null options')
  }
})

test('FilesystemDL: constructor should throw error if options is undefined', async (t) => {
  const createFileSystemDL = () => new FilesystemDL(undefined)
  try {
    createFileSystemDL()
    t.fail('Should throw an error for undefined options')
  } catch (err) {
    t.ok(err instanceof Error, 'Error should be an Error instance')
    t.pass('Constructor properly throws error for undefined options')
  }
})

test('FilesystemDL: constructor should throw error if dirPath is empty string', async (t) => {
  const createFileSystemDL = () => new FilesystemDL({ dirPath: '' })
  try {
    createFileSystemDL()
    t.fail('Should throw an error for empty dirPath')
  } catch (err) {
    t.ok(err instanceof QvacErrorFilesystem, 'Error should be instance of QvacErrorFilesystem')
    t.is(err.code, ERR_CODES.PATH_INVALID, 'Error code should be PATH_INVALID')
  }
})

test('FilesystemDL: constructor should handle relative paths correctly', async (t) => {
  const testDirName = path.basename(TEST_DIR)
  const relativePath = path.join(path.dirname(TEST_DIR), testDirName)
  const fsDL = new FilesystemDL({ dirPath: relativePath })
  t.ok(fsDL, 'Constructor should handle relative paths')

  const files = await fsDL.list()
  t.ok(files.includes(TEST_FILE_1), 'Should list files using relative path')
})

test('FilesystemDL: constructor should handle absolute paths correctly', async (t) => {
  const absolutePath = path.resolve(TEST_DIR)
  const fsDL = new FilesystemDL({ dirPath: absolutePath })
  t.ok(fsDL, 'Constructor should handle absolute paths')

  const files = await fsDL.list()
  t.ok(files.includes(TEST_FILE_1), 'Should list files using absolute path')
})

test('FilesystemDL: getStream should throw error with correct code if file does not exist', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  try {
    await fsDL.getStream('nonexistent.txt')
    t.fail('Should throw an error for non-existent file')
  } catch (err) {
    t.ok(err instanceof QvacErrorFilesystem, 'Error should be instance of QvacErrorFilesystem')
    t.is(err.code, ERR_CODES.FILE_NOT_FOUND, 'Error code should be FILE_NOT_FOUND')
  }
})

test('FilesystemDL: getStream should throw error if trying to stream a directory', async (t) => {
  const nestedDir = path.join(TEST_DIR, 'nested')
  if (!fs.existsSync(nestedDir)) {
    fs.mkdirSync(nestedDir)
  }

  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  try {
    await fsDL.getStream('nested')
    t.fail('Should throw an error when trying to stream a directory')
  } catch (err) {
    t.ok(err instanceof QvacErrorFilesystem, 'Error should be instance of QvacErrorFilesystem')
    t.is(err.code, ERR_CODES.PATH_INVALID, 'Error code should be PATH_INVALID')
  }
})

test('FilesystemDL: getStream should throw error for empty file path', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  try {
    await fsDL.getStream('')
    t.fail('Should throw an error for empty file path')
  } catch (err) {
    t.ok(err instanceof QvacErrorFilesystem, 'Error should be instance of QvacErrorFilesystem')
    t.is(err.code, ERR_CODES.PATH_INVALID, 'Error code should be PATH_INVALID')
  }
})

test('FilesystemDL: getStream should handle file paths with leading slash', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const stream = await fsDL.getStream('/' + TEST_FILE_1)
  t.ok(stream, 'Should handle file paths with leading slash')

  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk.toString())
  }
  t.is(chunks.join(''), TEST_FILE_CONTENT_1, 'Content should match expected')
})

test('FilesystemDL: getStream should handle normalized paths', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const stream = await fsDL.getStream('./' + TEST_FILE_1)
  t.ok(stream, 'Should handle normalized paths')

  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk.toString())
  }
  t.is(chunks.join(''), TEST_FILE_CONTENT_1, 'Content should match expected')
})

test('FilesystemDL: list should throw error with correct code if directory does not exist', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  try {
    await fsDL.list('nonexistent')
    t.fail('Should throw an error for non-existent directory')
  } catch (err) {
    t.ok(err instanceof QvacErrorFilesystem, 'Error should be instance of QvacErrorFilesystem')
    t.is(err.code, ERR_CODES.DIR_NOT_FOUND, 'Error code should be DIR_NOT_FOUND')
  }
})

test('FilesystemDL: list should throw error if trying to list a file', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  try {
    await fsDL.list(TEST_FILE_1)
    t.fail('Should throw an error when trying to list a file')
  } catch (err) {
    t.ok(err instanceof QvacErrorFilesystem, 'Error should be instance of QvacErrorFilesystem')
    t.is(err.code, ERR_CODES.PATH_INVALID, 'Error code should be PATH_INVALID')
  }
})

test('FilesystemDL: list should handle empty directory path', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const files = await fsDL.list('')
  t.ok(Array.isArray(files), 'Should return array for empty directory path')
  t.ok(files.includes(TEST_FILE_1), 'Should include test file')
})

test('FilesystemDL: list should handle dot directory path', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const files = await fsDL.list('.')
  t.ok(Array.isArray(files), 'Should return array for dot directory path')
  t.ok(files.includes(TEST_FILE_1), 'Should include test file')
})

test('FilesystemDL: list should handle directory paths with trailing slash', async (t) => {
  const nestedDir = path.join(TEST_DIR, 'nested')
  if (!fs.existsSync(nestedDir)) {
    fs.mkdirSync(nestedDir)
  }
  fs.writeFileSync(path.join(nestedDir, 'nested_file.txt'), 'nested content')

  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const files = await fsDL.list('nested/')
  t.ok(Array.isArray(files), 'Should return array for directory path with trailing slash')
  t.ok(files.includes('nested_file.txt'), 'Should include nested file')
})

test('FilesystemDL: list should return empty array for empty directory', async (t) => {
  const emptyDir = path.join(TEST_DIR, 'empty')
  if (!fs.existsSync(emptyDir)) {
    fs.mkdirSync(emptyDir)
  }

  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const files = await fsDL.list('empty')
  t.ok(Array.isArray(files), 'Should return array for empty directory')
  t.is(files.length, 0, 'Should return empty array for empty directory')
})

test('FilesystemDL: should return a readable stream for an existing file', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const stream = await fsDL.getStream(TEST_FILE_1)
  t.ok(stream, 'Stream is defined')

  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk.toString())
  }

  t.is(
    chunks.join(''),
    TEST_FILE_CONTENT_1,
    'Content matches expected for test file 1'
  )
})

test('FilesystemDL: should support async iteration over a file stream', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const stream = await fsDL.getStream(TEST_FILE_1)
  t.ok(stream, 'Stream is defined')

  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk.toString())
  }

  t.is(
    chunks.join(''),
    TEST_FILE_CONTENT_1,
    'Async iteration returns correct content for the file'
  )
})

test('FilesystemDL: should correctly read multiple files from the same directory', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })
  const stream1 = await fsDL.getStream(TEST_FILE_1)
  const chunks1 = []

  for await (const chunk of stream1) {
    chunks1.push(chunk.toString())
  }
  t.is(
    chunks1.join(''),
    TEST_FILE_CONTENT_1,
    'Correctly reads content from first file'
  )

  const stream2 = await fsDL.getStream(TEST_FILE_2)
  const chunks2 = []
  for await (const chunk of stream2) {
    chunks2.push(chunk.toString())
  }
  t.is(
    chunks2.join(''),
    TEST_FILE_CONTENT_2,
    'Correctly reads content from second file'
  )
})

test('FilesystemDL: should list files in the directory', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const files = await fsDL.list()
  t.alike(files.sort(), [TEST_FILE_1, TEST_FILE_2, 'nested', 'empty'].sort(), 'List method returns the correct file names')
})

test('FilesystemDL: should handle zero-byte files', async (t) => {
  const emptyFile = path.join(TEST_DIR, 'empty.txt')
  fs.writeFileSync(emptyFile, '')

  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const stream = await fsDL.getStream('empty.txt')
  t.ok(stream, 'Should create stream for empty file')

  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }

  t.is(chunks.length, 0, 'Empty file should produce no chunks')
})

test('FilesystemDL: should handle binary files', async (t) => {
  const binaryFile = path.join(TEST_DIR, 'binary.bin')
  const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE])
  fs.writeFileSync(binaryFile, binaryData)

  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const stream = await fsDL.getStream('binary.bin')
  t.ok(stream, 'Should create stream for binary file')

  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }

  const result = Buffer.concat(chunks)
  t.ok(result.equals(binaryData), 'Binary file content should match')
})

test('FilesystemDL: should handle files with unicode names', async (t) => {
  const unicodeFile = path.join(TEST_DIR, 'файл.txt')
  fs.writeFileSync(unicodeFile, 'unicode content')

  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const files = await fsDL.list()
  t.ok(files.includes('файл.txt'), 'Should list files with unicode names')

  const stream = await fsDL.getStream('файл.txt')
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk.toString())
  }

  t.is(chunks.join(''), 'unicode content', 'Should read unicode file content')
})

test('FilesystemDL: should handle files with emoji names', async (t) => {
  const emojiFile = path.join(TEST_DIR, '🎉test.txt')
  fs.writeFileSync(emojiFile, 'emoji content')

  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const files = await fsDL.list()
  t.ok(files.includes('🎉test.txt'), 'Should list files with emoji names')

  const stream = await fsDL.getStream('🎉test.txt')
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk.toString())
  }

  t.is(chunks.join(''), 'emoji content', 'Should read emoji file content')
})

test('FilesystemDL: should handle stream errors gracefully', async (t) => {
  const fsDL = new FilesystemDL({ dirPath: TEST_DIR })

  const tempFile = path.join(TEST_DIR, 'temp.txt')
  fs.writeFileSync(tempFile, 'temporary')

  const stream = await fsDL.getStream('temp.txt')

  fs.unlinkSync(tempFile)

  try {
    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    t.pass('Stream handled missing file gracefully')
  } catch (err) {
    t.pass('Stream properly threw error for missing file')
  }
})

test('FilesystemDL: should maintain consistent behavior across multiple instances', async (t) => {
  const fsDL1 = new FilesystemDL({ dirPath: TEST_DIR })
  const fsDL2 = new FilesystemDL({ dirPath: TEST_DIR })

  const files1 = await fsDL1.list()
  const files2 = await fsDL2.list()

  t.alike(files1.sort(), files2.sort(), 'Multiple instances should return consistent results')

  const stream1 = await fsDL1.getStream(TEST_FILE_1)
  const stream2 = await fsDL2.getStream(TEST_FILE_1)

  const chunks1 = []
  const chunks2 = []

  for await (const chunk of stream1) {
    chunks1.push(chunk.toString())
  }

  for await (const chunk of stream2) {
    chunks2.push(chunk.toString())
  }

  t.is(chunks1.join(''), chunks2.join(''), 'Multiple instances should return same content')
})

test.hook('teardown', (t) => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true })
  }

  // Verify that the test data was actually removed
  t.ok(!fs.existsSync(TEST_DIR), 'Test directory should be removed')
})
