'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../regression/coexistence-worker.js'), 'utf8')

function run(order, mutateOnLoad = 0) {
  let count = 1
  let loads = 0
  const output = []
  const fabric = { loadBackends: () => count }
  const diffusion = {
    getExpectedEsrganBackendDevice: () => {
      if (++loads === mutateOnLoad) count++
      return 'cpu'
    }
  }
  vm.runInNewContext(source, {
    Bare: { argv: ['/runtime/bin/bare', 'worker.js', order, 'fabric', 'diffusion', 'backends'] },
    require: { addon: (file) => (file === 'fabric' ? fabric : diffusion) },
    console: { log: (line) => output.push(JSON.parse(line)) }
  })
  return output[0]
}

test('checks registry stability during the first diffusion load', () => {
  assert.throws(() => run('fabric-first', 1), /during first diffusion load/)
})

test('checks registry stability on repeated diffusion calls too', () => {
  assert.throws(() => run('fabric-first', 2), /after diffusion call/)
})

test('both supported load orders report their actual host', () => {
  for (const order of ['fabric-first', 'diffusion-first']) {
    const result = run(order)
    assert.equal(result.order, order)
    assert.equal(result.fabricBackends, 1)
    assert.equal(result.hostExecutable, '/runtime/bin/bare')
  }
})
