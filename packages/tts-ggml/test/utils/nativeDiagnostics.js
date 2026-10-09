'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
let emittedLength = 0

function readNativeDiagnostics() {
  const logPath = os.getEnv('QVAC_TTS_NATIVE_STDERR_PATH')
  return logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
}

function denoiserDeclinesGpu(platform, diagnostics) {
  return (
    platform === 'android' &&
    /\[native-backend\] selected=Vulkan\d* description=.*(?:Mali|Immortalis)/i.test(diagnostics)
  )
}

function emitNativeDiagnostics() {
  const diagnostics = readNativeDiagnostics()
  if (diagnostics.length < emittedLength) emittedLength = 0
  emitNativeLines(diagnostics.slice(emittedLength))
  emittedLength = diagnostics.length
}

function emitNativeLines(text) {
  for (const line of text.split('\n')) {
    if (line) console.log('[native-stderr]', line)
  }
}

module.exports = { readNativeDiagnostics, denoiserDeclinesGpu, emitNativeDiagnostics }
