'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

const PACKAGE_ROOT = path.join(__dirname, '..', '..')

test('package entry point exposes the public surface without loading the native binding', (t) => {
  const pkgExports = require('../..')

  t.is(typeof pkgExports.OcrGgml, 'function', 'OcrGgml class is exported')
  t.is(pkgExports.modelClass, pkgExports.OcrGgml, 'modelClass aliases OcrGgml')
  t.is(typeof pkgExports.QvacErrorAddonOcrGgml, 'function', 'QvacErrorAddonOcrGgml is exported')
  t.is(typeof pkgExports.ERR_CODES, 'object', 'ERR_CODES is exported')

  const descriptors = Object.getOwnPropertyDescriptors(pkgExports)
  t.is(typeof descriptors.binding.get, 'function', 'binding is a lazy getter')
  t.is(typeof descriptors.addonLogging.get, 'function', 'addonLogging is a lazy getter')
  t.is(typeof descriptors.modelFile.get, 'function', 'modelFile is a lazy getter')
})

test('published entrypoints only require declared runtime dependencies', (t) => {
  const pkg = require('../../package.json')
  const declared = pkg.dependencies || {}

  const entrypoints = ['index.js', 'ocr-ggml.js', 'addonLogging.js', 'binding.js', 'lib/error.js']
  const requireRe = /require\((["'])([^"']+)\1\)/g

  for (const file of entrypoints) {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8')
    for (const match of source.matchAll(requireRe)) {
      const id = match[2]
      if (id.startsWith('.')) continue
      const packageName = id.startsWith('@')
        ? id.split('/').slice(0, 2).join('/')
        : id.split('/')[0]
      t.ok(
        Object.hasOwn(declared, packageName),
        `${file} requires '${packageName}' which is declared in dependencies`
      )
    }
  }
})

test('ERR_CODES stays frozen with stable code values', (t) => {
  const { ERR_CODES } = require('../..')

  t.ok(Object.isFrozen(ERR_CODES), 'ERR_CODES is frozen')
  for (const [name, code] of Object.entries(ERR_CODES)) {
    t.ok(code >= 8101 && code <= 8200, `${name} (${code}) is inside the allocated 8101..8200 range`)
  }
})
