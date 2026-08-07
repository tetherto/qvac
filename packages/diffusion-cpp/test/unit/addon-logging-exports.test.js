'use strict'

// cjs-module-lexer discovers a CommonJS module's named exports statically and
// only detects top-level `exports.X =`; any other form links with none.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

test('addonLogging emits the top-level assignments the lexer needs', (t) => {
  const emitted = fs.readFileSync(path.join(__dirname, '..', '..', 'addonLogging.js'), 'utf8')

  t.ok(emitted.includes('exports.setLogger = '), 'setLogger is a top-level exports assignment')
  t.ok(
    emitted.includes('exports.releaseLogger = '),
    'releaseLogger is a top-level exports assignment'
  )
  t.ok(
    emitted.includes('module.exports = addonLogging'),
    'module.exports stays the bare addonLogging object'
  )
})
