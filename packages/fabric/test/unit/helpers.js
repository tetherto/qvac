'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const packageRoot = path.resolve(__dirname, '../..')

// The shipped files run under Bare, whose `require` carries `require.addon`.
// Evaluate the real source against a controlled `require` so the tests cover
// exactly what gets published. `makeRequire` receives the module being loaded,
// so a fake can hand back its half-built exports.
function evaluate(file, makeRequire) {
  const filename = path.join(packageRoot, file)
  const module_ = { exports: {} }
  const wrapper = vm.compileFunction(
    fs.readFileSync(filename, 'utf8'),
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename }
  )
  wrapper(module_.exports, makeRequire(module_), module_, filename, packageRoot)
  return module_
}

module.exports = { evaluate, packageRoot }
