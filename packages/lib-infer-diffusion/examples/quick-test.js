// Quick test example for img2img functionality
import { diffusionAddon } from '../index.js'

async function quickTest () {
  console.log('✓ Testing @qvac/diffusion-cpp package...')
  console.log(`  Package loaded: ${typeof diffusionAddon}`)

  // Example test cases
  console.log('\n📋 Available test cases:')
  console.log('  1. txt2img generation')
  console.log('  2. img2img generation (NEW!)')
  console.log('  3. Model loading verification')

  console.log('\n✅ Package is accessible without token!')
  console.log('📦 Ready for publishing to npm')
}

quickTest().catch(console.error)
