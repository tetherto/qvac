'use strict'

const test = require('brittle')
const ProgressReport = require('../../src/utils/progressReport')

test('ProgressReport - initializes with correct values', (t) => {
  const filesizeMapping = {
    'file1.txt': 100,
    'file2.txt': 200
  }
  const progressReport = new ProgressReport(filesizeMapping)

  t.is(progressReport.totalSize, 300)
  t.is(progressReport.totalFiles, 2)
  t.is(progressReport.overallProgress, '0.00')
  t.is(progressReport.filesProcessed, 0)
})

test('ProgressReport - updates progress correctly', (t) => {
  const filesizeMapping = {
    'file1.txt': 100,
    'file2.txt': 200
  }
  const progressReport = new ProgressReport(filesizeMapping)

  let callbackData = null
  const callback = (data) => { callbackData = data }

  progressReport.progressCallback = callback
  progressReport.update('file1.txt', 50)

  t.is(progressReport.overallProgress, '16.67')
  t.is(progressReport.downloadedSizeMapping['file1.txt'], 50)
  t.is(callbackData.action, 'loadingFile')
  t.is(callbackData.currentFile, 'file1.txt')
  t.is(callbackData.currentFileProgress, '50.00')
})

test('ProgressReport - completes file correctly', (t) => {
  const filesizeMapping = {
    'file1.txt': 100,
    'file2.txt': 200
  }
  const progressReport = new ProgressReport(filesizeMapping)

  let callbackData = null
  const callback = (data) => { callbackData = data }

  progressReport.progressCallback = callback
  progressReport.update('file1.txt', 50)
  progressReport.completeFile('file1.txt')

  t.is(progressReport.overallProgress, '33.33')
  t.is(progressReport.downloadedSizeMapping['file1.txt'], 100)
  t.is(progressReport.filesProcessed, 1)
  t.is(callbackData.action, 'completeFile')
  t.is(callbackData.currentFile, 'file1.txt')
  t.is(callbackData.currentFileProgress, '100.00')
})

test('ProgressReport - handles multiple files correctly', (t) => {
  const filesizeMapping = {
    'file1.txt': 100,
    'file2.txt': 200
  }
  const progressReport = new ProgressReport(filesizeMapping)

  let callbackData = null
  const callback = (data) => { callbackData = data }

  progressReport.progressCallback = callback
  progressReport.update('file1.txt', 50)
  progressReport.completeFile('file1.txt')
  progressReport.update('file2.txt', 100)
  progressReport.completeFile('file2.txt')

  t.is(progressReport.overallProgress, '100.00')
  t.is(progressReport.downloadedSizeMapping['file1.txt'], 100)
  t.is(progressReport.downloadedSizeMapping['file2.txt'], 200)
  t.is(progressReport.filesProcessed, 2)
  t.is(callbackData.action, 'completeFile')
  t.is(callbackData.currentFile, 'file2.txt')
  t.is(callbackData.currentFileProgress, '100.00')
})

test('ProgressReport - handles zero-sized files', (t) => {
  const filesizeMapping = {
    'empty.txt': 0,
    'normal.txt': 100
  }
  const progressReport = new ProgressReport(filesizeMapping)

  t.is(progressReport.totalSize, 100)
  t.is(progressReport.totalFiles, 2)

  progressReport.completeFile('empty.txt')
  t.is(progressReport.filesProcessed, 1)
})

test('ProgressReport - works without callback function', (t) => {
  const filesizeMapping = { 'file1.txt': 100 }
  const progressReport = new ProgressReport(filesizeMapping)

  progressReport.update('file1.txt', 50)
  progressReport.completeFile('file1.txt')

  t.is(progressReport.overallProgress, '100.00')
  t.is(progressReport.filesProcessed, 1)
})

test('ProgressReport - handles updating file that does not exist in mapping', (t) => {
  const filesizeMapping = { 'file1.txt': 100 }
  const progressReport = new ProgressReport(filesizeMapping)

  progressReport.update('unknown.txt', 50)

  t.is(progressReport.downloadedSizeMapping['unknown.txt'], 50)
  t.is(progressReport.overallDownloaded, 50)
})

test('ProgressReport - handles completing file with partial download', (t) => {
  const filesizeMapping = { 'file1.txt': 100 }
  const progressReport = new ProgressReport(filesizeMapping)

  progressReport.update('file1.txt', 60)
  t.is(progressReport.overallProgress, '60.00')

  progressReport.completeFile('file1.txt')
  t.is(progressReport.overallProgress, '100.00')
  t.is(progressReport.overallDownloaded, 100)
})

test('ProgressReport - handles completing file with no prior download', (t) => {
  const filesizeMapping = { 'file1.txt': 100 }
  const progressReport = new ProgressReport(filesizeMapping)

  progressReport.completeFile('file1.txt')

  t.is(progressReport.overallProgress, '100.00')
  t.is(progressReport.downloadedSizeMapping['file1.txt'], 100)
  t.is(progressReport.filesProcessed, 1)
})

test('ProgressReport - handles completing file with over-download', (t) => {
  const filesizeMapping = { 'file1.txt': 100 }
  const progressReport = new ProgressReport(filesizeMapping)

  progressReport.update('file1.txt', 120)

  progressReport.completeFile('file1.txt')

  t.is(progressReport.downloadedSizeMapping['file1.txt'], 120)
  t.is(progressReport.overallDownloaded, 120)
})

test('ProgressReport - calculates progress correctly with empty mapping', (t) => {
  const filesizeMapping = {}
  const progressReport = new ProgressReport(filesizeMapping)

  t.is(progressReport.totalSize, 0)
  t.is(progressReport.totalFiles, 0)
  t.is(progressReport.overallProgress, '0.00')

  progressReport.update('file1.txt', 50)
  progressReport.completeFile('file1.txt')

  t.is(progressReport.filesProcessed, 1)
})
