'use strict'

const fs = require('fs')
const path = require('path')

function sanitizeName (value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function getRemotePaths (platformName, bundleId) {
  if (platformName === 'ios') {
    return [`@${bundleId}:documents/perf-report.json`]
  }

  return [
    `/sdcard/Android/data/${bundleId}/files/perf-report.json`,
    `/storage/emulated/0/Android/data/${bundleId}/files/perf-report.json`,
    '/data/local/tmp/perf-report.json',
    `/data/user/0/${bundleId}/files/perf-report.json`,
    `/data/data/${bundleId}/files/perf-report.json`
  ]
}

function writePulledReport (rawBase64, options) {
  const outputDir = process.env.DEVICEFARM_LOG_DIR || process.cwd()
  const decoded = Buffer.from(rawBase64, 'base64').toString('utf8')
  const parsed = JSON.parse(decoded)
  const fileName = `perf-report-${sanitizeName(options.testName)}.json`
  const outputPath = path.join(outputDir, fileName)

  try {
    fs.mkdirSync(outputDir, { recursive: true })
  } catch (_) {}

  fs.writeFileSync(outputPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8')

  const meanRtf = parsed.summary && parsed.summary.rtf && parsed.summary.rtf.mean
  console.log(`[perf-report] saved ${outputPath} from ${options.remotePath}`)
  if (meanRtf !== undefined) {
    console.log(`[perf-report] ${options.testName} meanRtf=${Number(meanRtf).toFixed(4)}`)
  }

  return outputPath
}

async function persistPerfReport (browser, options) {
  const platformName = String(options.platformName || '').toLowerCase()
  const remotePaths = getRemotePaths(platformName, options.bundleId)
  let lastError = null

  for (const remotePath of remotePaths) {
    try {
      const rawBase64 = await browser.pullFile(remotePath)
      if (!rawBase64) continue
      writePulledReport(rawBase64, {
        testName: options.testName,
        remotePath
      })
      return true
    } catch (error) {
      lastError = error
    }
  }

  if (lastError) {
    console.log(`[perf-report] ${options.testName} not available: ${lastError.message}`)
  } else {
    console.log(`[perf-report] ${options.testName} not available`)
  }

  return false
}

module.exports = {
  persistPerfReport
}
