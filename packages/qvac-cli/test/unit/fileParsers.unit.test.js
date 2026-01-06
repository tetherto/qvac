'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { parseFileDependencies } = require('../../src/utils/fileParsers')

test('parseFileDependencies extracts CommonJS requires', (t) => {
  const testFile = path.join(process.cwd(), 'test-file.js')
  const content = `
    const fs = require('fs')
    const path = require('path')
    const { something } = require('some-package')
    const other = require('another-package')
  `

  try {
    fs.writeFileSync(testFile, content)

    const dependencies = parseFileDependencies(testFile)

    t.ok(dependencies.includes('fs'), 'should include fs')
    t.ok(dependencies.includes('path'), 'should include path')
    t.ok(dependencies.includes('some-package'), 'should include some-package')
    t.ok(dependencies.includes('another-package'), 'should include another-package')
    t.is(dependencies.length, 4, 'should have 4 dependencies')
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile)
    }
  }
})

test('parseFileDependencies extracts ESM imports', (t) => {
  const testFile = path.join(process.cwd(), 'test-file.js')
  const content = `
    import fs from 'fs'
    import { path } from 'path'
    import * as utils from 'some-utils'
    import { thing1, thing2 } from 'another-package'
  `

  try {
    fs.writeFileSync(testFile, content)

    const dependencies = parseFileDependencies(testFile)

    t.ok(dependencies.includes('fs'), 'should include fs')
    t.ok(dependencies.includes('path'), 'should include path')
    t.ok(dependencies.includes('some-utils'), 'should include some-utils')
    t.ok(dependencies.includes('another-package'), 'should include another-package')
    t.is(dependencies.length, 4, 'should have 4 dependencies')
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile)
    }
  }
})

test('parseFileDependencies handles mixed imports', (t) => {
  const testFile = path.join(process.cwd(), 'test-file.js')
  const content = `
    const fs = require('fs')
    import { path } from 'path'
    const utils = require('some-utils')
    import { thing } from 'another-package'
  `

  try {
    fs.writeFileSync(testFile, content)

    const dependencies = parseFileDependencies(testFile)

    t.ok(dependencies.includes('fs'), 'should include fs')
    t.ok(dependencies.includes('path'), 'should include path')
    t.ok(dependencies.includes('some-utils'), 'should include some-utils')
    t.ok(dependencies.includes('another-package'), 'should include another-package')
    t.is(dependencies.length, 4, 'should have 4 dependencies')
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile)
    }
  }
})

test('parseFileDependencies ignores specified packages', (t) => {
  const testFile = path.join(process.cwd(), 'test-file.js')
  const content = `
    const fs = require('fs')
    const path = require('path')
    const config = require('./example.config.json')
    const utils = require('some-utils')
  `

  try {
    fs.writeFileSync(testFile, content)

    const dependencies = parseFileDependencies(testFile, ['./example.config.json'])

    t.ok(dependencies.includes('fs'), 'should include fs')
    t.ok(dependencies.includes('path'), 'should include path')
    t.ok(dependencies.includes('some-utils'), 'should include some-utils')
    t.ok(!dependencies.includes('./example.config.json'), 'should not include ignored package')
    t.is(dependencies.length, 3, 'should have 3 dependencies')
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile)
    }
  }
})

test('parseFileDependencies returns unique dependencies', (t) => {
  const testFile = path.join(process.cwd(), 'test-file.js')
  const content = `
    const fs = require('fs')
    const fs2 = require('fs')
    import { path } from 'path'
    import path2 from 'path'
    const utils = require('some-utils')
  `

  try {
    fs.writeFileSync(testFile, content)

    const dependencies = parseFileDependencies(testFile)

    t.ok(dependencies.includes('fs'), 'should include fs')
    t.ok(dependencies.includes('path'), 'should include path')
    t.ok(dependencies.includes('some-utils'), 'should include some-utils')
    t.is(dependencies.length, 3, 'should have 3 unique dependencies')
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile)
    }
  }
})

test('parseFileDependencies handles empty file', (t) => {
  const testFile = path.join(process.cwd(), 'test-file.js')
  const content = ''

  try {
    fs.writeFileSync(testFile, content)

    const dependencies = parseFileDependencies(testFile)

    t.is(dependencies.length, 0, 'should return empty array for empty file')
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile)
    }
  }
})

test('parseFileDependencies handles file with no imports', (t) => {
  const testFile = path.join(process.cwd(), 'test-file.js')
  const content = `
    console.log('Hello World')
    const x = 1 + 1
    function test() {
      return true
    }
  `

  try {
    fs.writeFileSync(testFile, content)

    const dependencies = parseFileDependencies(testFile)

    t.is(dependencies.length, 0, 'should return empty array for file with no imports')
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile)
    }
  }
})
