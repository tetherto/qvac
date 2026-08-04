const test = require('brittle')
const manifest = require('../package.json')

test('supervisor exports only lifecycle API and package metadata', (t) => {
  t.alike(Object.keys(manifest.exports).sort(), ['.', './package'])
  t.alike(manifest.files.sort(), [
    'index.d.ts',
    'index.js',
    'package.json'
  ])
})
