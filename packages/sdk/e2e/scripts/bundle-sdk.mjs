import { bundleSdk } from '@qvac/sdk/commands'

try {
  const result = await bundleSdk({
    configPath: 'fixtures/qvac.config.e2e.json'
  })

  console.log(`Bundled ${result.plugins.length} plugins:`)
  for (const plugin of result.plugins) {
    console.log(`  ${plugin}`)
  }
} catch (error) {
  console.error(`\n❌ bundleSdk failed: ${error instanceof Error ? error.message : error}\n`)
  process.exitCode = 1
}
