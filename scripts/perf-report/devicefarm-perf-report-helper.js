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
    return [
      `@${bundleId}:documents/perf-report.json`,
      `@${bundleId}:Documents/perf-report.json`,
      `@${bundleId}/perf-report.json`
    ]
  }

  return [
    `/sdcard/Android/data/${bundleId}/files/perf-report.json`,
    `/storage/emulated/0/Android/data/${bundleId}/files/perf-report.json`,
    '/data/local/tmp/perf-report.json',
    `/data/user/0/${bundleId}/files/perf-report.json`,
    `/data/data/${bundleId}/files/perf-report.json`
  ]
}

function writePulledReport (jsonText, options) {
  const outputDir = process.env.DEVICEFARM_LOG_DIR || process.cwd()
  const parsed = JSON.parse(jsonText)
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

function decodeBase64Report (rawBase64) {
  return Buffer.from(rawBase64, 'base64').toString('utf8')
}

function getShellStdout (result) {
  if (!result) return ''
  if (typeof result === 'string') return result
  if (typeof result.stdout === 'string') return result.stdout
  return ''
}

function shouldCollectPerfReport (testName) {
  return /^runRtfBenchmark/.test(String(testName || ''))
}

async function sleep (ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function tryAndroidRunAs (browser, bundleId) {
  const result = await browser.execute('mobile: shell', {
    command: 'run-as',
    args: [bundleId, 'cat', 'files/perf-report.json'],
    includeStderr: true,
    timeout: 10000
  })

  return getShellStdout(result).trim()
}

async function persistPerfReport (browser, options) {
  if (!shouldCollectPerfReport(options.testName)) {
    return false
  }

  const platformName = String(options.platformName || '').toLowerCase()
  const remotePaths = getRemotePaths(platformName, options.bundleId)
  let lastError = null

  for (let attempt = 0; attempt < 10; attempt++) {
    for (const remotePath of remotePaths) {
      try {
        const rawBase64 = await browser.pullFile(remotePath)
        if (!rawBase64) continue
        writePulledReport(decodeBase64Report(rawBase64), {
          testName: options.testName,
          remotePath
        })
        return true
      } catch (error) {
        lastError = error
      }
    }

    if (platformName === 'android') {
      try {
        const stdout = await tryAndroidRunAs(browser, options.bundleId)
        if (stdout) {
          writePulledReport(stdout, {
            testName: options.testName,
            remotePath: `run-as:${options.bundleId}:files/perf-report.json`
          })
          return true
        }
      } catch (error) {
        lastError = error
      }
    }

    if (attempt < 9) {
      await sleep(1000)
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
