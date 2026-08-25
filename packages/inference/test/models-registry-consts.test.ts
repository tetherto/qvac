import test from 'brittle'
import * as registryModels from '@/models/registry/models'

// Each named model constant (e.g. `AUDIOGEN_VAE_BF16`) is a projection of one
// `models` array entry, indexed by position. Position and name must agree: a
// constant whose fields are read from the wrong index silently resolves to a
// different model's `src`, checksum and blob offsets. This asserts that every
// exported constant carries the metadata of the array entry that shares its
// name.
test('every model constant resolves to the array entry with its name', (t) => {
  const { models } = registryModels
  const indexByName = new Map(models.map((model, index) => [model.name, index]))

  for (const [exportName, value] of Object.entries(registryModels)) {
    if (exportName === 'models') continue
    if (typeof value !== 'object' || value === null) continue
    if (!('name' in value) || !('registryPath' in value)) continue

    const index = indexByName.get(value.name)
    t.ok(index !== undefined, `${exportName}: no models entry named "${value.name}"`)
    if (index === undefined) continue

    t.is(
      value.registryPath,
      models[index].registryPath,
      `${exportName} must project models[${index}] ("${value.name}")`
    )
  }
})
