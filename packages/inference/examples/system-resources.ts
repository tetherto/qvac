// Inspect locally observed CPU, system-memory, GPU, and driver capabilities.
//
// A resource query uses no model, but engines must still be assembled before
// the first call — register the ones you care about, then query. Pass
// `sample: true` when you also need a fresh usage sample. Every metric reports
// `supported`, `unavailable`, `unverified`, or `failed`; these values are
// diagnostics and do not reserve memory or guarantee a model can be loaded.
//
// Run: bare examples/system-resources.ts
// Requires: npm install @qvac/inference @qvac/llm-llamacpp

import { registerPlugin, getSystemResources, close } from '@qvac/inference'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

try {
  const resources = await getSystemResources({ sample: true })

  if (resources.capabilities.memory.totalBytes.status === 'supported') {
    console.log('▸ System memory:', resources.capabilities.memory.totalBytes.value)
  }

  if (resources.sample?.cpu.status === 'supported') {
    console.log('▸ CPU utilization:', resources.sample.cpu.value)
  }

  await close()
} catch (error) {
  console.error('✖', error)
}
