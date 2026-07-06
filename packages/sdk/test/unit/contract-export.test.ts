import test from 'brittle'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  buildContract,
  callShapeByHandlerType,
  contractDir,
  renderContractFiles
} from '@/scripts/contract/build-contract'
import { methodShapes } from '@/server/rpc/method-shapes'

test('manifest lists every method with its call shape', (t) => {
  const { manifest } = buildContract()
  const names = manifest.methods.map((method) => method.name)

  t.alike(names, Object.keys(methodShapes).sort(), 'one manifest entry per method, sorted')

  for (const method of manifest.methods) {
    t.is(
      method.callShape,
      callShapeByHandlerType[methodShapes[method.name]],
      `${method.name} call shape`
    )
  }
})

test('schema document has request and response defs for every method', (t) => {
  const { schemaDocument, manifest } = buildContract()
  const defs = schemaDocument.$defs

  for (const method of manifest.methods) {
    t.ok(defs[`${method.name}.request`], `${method.name}.request def`)
    t.ok(defs[`${method.name}.response`], `${method.name}.response def`)
  }

  const requestUnion = defs['request'] as { anyOf: Array<{ $ref: string }> }
  t.alike(
    requestUnion.anyOf.map((entry) => entry.$ref),
    manifest.methods.map((method) => `#/$defs/${method.name}.request`),
    'request union references every method request'
  )
})

test('export is deterministic across runs', async (t) => {
  const first = await renderContractFiles()
  const second = await renderContractFiles()

  t.is(first['schema.json'], second['schema.json'])
  t.is(first['manifest.json'], second['manifest.json'])
})

test('committed artifacts are up to date', async (t) => {
  const rendered = await renderContractFiles()

  for (const [name, content] of Object.entries(rendered)) {
    const committed = await readFile(fileURLToPath(new URL(name, contractDir)), 'utf8')
    t.is(committed, content, `contract/${name} matches a fresh export`)
  }
})
