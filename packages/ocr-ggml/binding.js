'use strict'

try {
  module.exports = require.addon()
} catch (e) {
  const c = e && e.cause
  console.log('[OCR-DLOPEN-DEBUG] error:', e && e.message)
  console.log('[OCR-DLOPEN-DEBUG] error.code:', e && e.code)
  console.log('[OCR-DLOPEN-DEBUG] cause:', c)
  console.log('[OCR-DLOPEN-DEBUG] cause.message:', c && c.message)
  console.log('[OCR-DLOPEN-DEBUG] cause.code:', c && c.code)
  console.log('[OCR-DLOPEN-DEBUG] cause.errno:', c && c.errno)
  console.log('[OCR-DLOPEN-DEBUG] cause.path:', c && c.path)
  console.log('[OCR-DLOPEN-DEBUG] cause.syscall:', c && c.syscall)
  console.log('[OCR-DLOPEN-DEBUG] cause.stack:', c && c.stack)
  try {
    console.log('[OCR-DLOPEN-DEBUG] cause.keys:', c && Object.getOwnPropertyNames(c))
    console.log('[OCR-DLOPEN-DEBUG] cause.JSON:', c && JSON.stringify(c, Object.getOwnPropertyNames(c)))
  } catch (_) {}
  throw e
}
