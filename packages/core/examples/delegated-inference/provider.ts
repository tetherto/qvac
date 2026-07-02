// Remote inference — provider side. Serves delegated inference to remote peers
// over Hyperswarm. Run this, copy the printed public key, then run consumer.ts
// with it. Delegation is peer-to-peer and lives entirely in core.
//
// Run: bare examples/delegated-inference/provider.ts [seed-hex]
// Requires: npm install @qvac/core @qvac/llm-llamacpp

import env from 'bare-env'
import { registerPlugin, startQVACProvider } from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

// The provider builds models locally when a delegated loadModel arrives, so it
// registers the engines it will serve.
registerPlugin(llmPlugin)

// Optional 64-char hex seed for a deterministic provider identity.
const seed = Bare.argv.slice(2)[0]
if (seed) env['QVAC_HYPERSWARM_SEED'] = seed

try {
  const { publicKey } = await startQVACProvider({})
  console.log(`▸ Provider public key: ${publicKey}`)
  console.log(`▸ Run: bare examples/delegated-inference/consumer.ts ${publicKey}`)
  console.log('▸ Provider running. Ctrl+C to stop.')

  // Keep the process alive while the swarm serves requests.
  await new Promise(() => {})
} catch (error) {
  console.error('✖', error)
}
