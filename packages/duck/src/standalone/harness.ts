import process from 'bare-process'
import { fileURLToPath } from 'bare-url'
import start from '@qvac/harness/worker/harness-sidecar.mjs'

// Resolve a literal so stow includes the extension and its plugins in this bundle.
// The sidecar imports this bundle-local URL through its existing host-module hook.
const extension = import.meta.resolve('../lib/runtime/harness-extension.js')

export default function startHarness(...args: Parameters<typeof start>) {
  process.env['QVAC_HARNESS_HOST_MODULE'] = fileURLToPath(extension)
  return start(...args)
}
