'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { QvacStorage } = require('../../src/utils/storage')

test('QvacStorage constructor creates singleton', (t) => {
  QvacStorage.reset()

  const storage1 = new QvacStorage({ storageDir: '/test/dir' })
  const storage2 = new QvacStorage({ storageDir: '/different/dir' })

  t.is(storage1, storage2, 'should return the same instance')
  t.is(storage1.storageRoot, '/test/dir', 'should use first config storageDir')
})

test('QvacStorage.getInstance returns singleton', (t) => {
  QvacStorage.reset()

  const storage1 = QvacStorage.getInstance()
  const storage2 = QvacStorage.getInstance()

  t.is(storage1, storage2, 'should return the same instance')
})

test('QvacStorage.addFile creates file with content', async (t) => {
  QvacStorage.reset()

  const testDir = path.join(process.cwd(), 'test-storage')
  const storage = new QvacStorage({ storageDir: testDir })

  try {
    const fileName = 'test-file.txt'
    const content = 'test content'

    await storage.addFile(fileName, content)

    const filePath = path.join(testDir, fileName)
    t.ok(fs.existsSync(filePath), 'file should be created')

    const readContent = fs.readFileSync(filePath, 'utf8')
    t.is(readContent, content, 'file content should match')
  } finally {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  }
})

test('QvacStorage.addFile creates nested directories', async (t) => {
  QvacStorage.reset()

  const testDir = path.join(process.cwd(), 'test-storage')
  const storage = new QvacStorage({ storageDir: testDir })

  try {
    const fileName = 'nested/dir/test-file.txt'
    const content = 'test content'

    await storage.addFile(fileName, content)

    const filePath = path.join(testDir, fileName)
    t.ok(fs.existsSync(filePath), 'file should be created in nested directory')

    const readContent = fs.readFileSync(filePath, 'utf8')
    t.is(readContent, content, 'file content should match')
  } finally {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  }
})

test('QvacStorage.appendFile appends to existing file', async (t) => {
  QvacStorage.reset()

  const testDir = path.join(process.cwd(), 'test-storage')
  const storage = new QvacStorage({ storageDir: testDir })

  try {
    const fileName = 'append-test.txt'
    const initialContent = 'initial content\n'
    const appendContent = 'appended content'

    // Create initial file
    await storage.addFile(fileName, initialContent)

    // Append content
    await storage.appendFile(fileName, appendContent)

    const filePath = path.join(testDir, fileName)
    const readContent = fs.readFileSync(filePath, 'utf8')
    t.is(readContent, initialContent + appendContent, 'content should be appended')
  } finally {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  }
})

test('QvacStorage.appendFile creates file if not exists', async (t) => {
  QvacStorage.reset()

  const testDir = path.join(process.cwd(), 'test-storage')
  const storage = new QvacStorage({ storageDir: testDir })

  try {
    const fileName = 'new-append-test.txt'
    const content = 'new content'

    await storage.appendFile(fileName, content)

    const filePath = path.join(testDir, fileName)
    t.ok(fs.existsSync(filePath), 'file should be created')

    const readContent = fs.readFileSync(filePath, 'utf8')
    t.is(readContent, content, 'file content should match')
  } finally {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  }
})

test('QvacStorage.readFile reads file content', async (t) => {
  QvacStorage.reset()

  const testDir = path.join(process.cwd(), 'test-storage')
  const storage = new QvacStorage({ storageDir: testDir })

  try {
    const fileName = 'read-test.txt'
    const content = 'read test content'

    await storage.addFile(fileName, content)

    const readContent = await storage.readFile(fileName)
    t.is(readContent, content, 'read content should match')
  } finally {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  }
})

test('QvacStorage.readFile throws error for non-existent file', async (t) => {
  QvacStorage.reset()

  const testDir = path.join(process.cwd(), 'test-storage')
  const storage = new QvacStorage({ storageDir: testDir })

  try {
    await t.exception(
      storage.readFile('non-existent.txt'),
      'should throw error for non-existent file'
    )
  } finally {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  }
})
