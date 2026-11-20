import { getRuntimeCapabilities, type RuntimeCapability } from '@qvac/sdk'

// The contracts and majors this app was built against.
const REQUIRED = [
  { id: 'completion', version: 1 },
  { id: 'transcription', version: 1 }
]

function describe(capability: RuntimeCapability) {
  const partial = capability.partialOperations.length
    ? `; only some plugins: ${capability.partialOperations.join(', ')}`
    : ''
  return `${capability.id}@${capability.version}: ${capability.operations.join(', ')}${partial}`
}

try {
  const capabilities = await getRuntimeCapabilities()

  console.log('▸ Capability contracts the runtime provides')
  for (const capability of capabilities) console.log(`  ${describe(capability)}`)

  const missing = REQUIRED.filter(
    (required) =>
      !capabilities.some(
        (capability) => capability.id === required.id && capability.version === required.version
      )
  )
  if (missing.length > 0) {
    console.error(`✖ Missing: ${missing.map((m) => `${m.id}@${m.version}`).join(', ')}`)
    process.exit(1)
  }

  console.log('\n▸ Every required contract is available.')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
