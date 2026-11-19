import test from 'brittle'
import { readFileSync } from 'node:fs'

// The exported contract is what the Kotlin and Python clients are generated
// from. Every method's request must list the caller session there, so a
// generated client can never send a request the engine would treat as the
// owner's by accident.

type JsonSchema = Record<string, unknown>

function requestObjects(node: JsonSchema): JsonSchema[] {
  const variants = (node['oneOf'] ?? node['anyOf']) as JsonSchema[] | undefined
  if (variants) return variants.flatMap(requestObjects)
  if (node['properties']) return [node]
  throw new Error(`request schema without properties: ${JSON.stringify(node).slice(0, 120)}`)
}

test('contract: every method request carries sessionId', (t) => {
  const manifest = JSON.parse(
    readFileSync(new URL('../contract/manifest.json', import.meta.url), 'utf8')
  ) as { methods: { name: string; requestSchema: string }[] }
  const schema = JSON.parse(
    readFileSync(new URL('../contract/schema.json', import.meta.url), 'utf8')
  ) as { $defs: Record<string, JsonSchema> }

  t.ok(manifest.methods.length > 40, `${manifest.methods.length} methods in the manifest`)
  for (const method of manifest.methods) {
    const key = method.requestSchema.replace('schema.json#/$defs/', '')
    const definition = schema.$defs[key]
    t.ok(definition, `${method.name} request is defined`)
    if (!definition) continue
    for (const object of requestObjects(definition)) {
      const properties = object['properties'] as JsonSchema
      t.ok(properties['sessionId'], `${method.name} request lists sessionId`)
    }
  }
})
