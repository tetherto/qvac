import type { ProductCommand } from '../commands.js'

// The dashboard pages a chat command opens.
export const commands: ProductCommand[] = [
  { name: 'overview', desc: 'Workspace dashboard' },
  { name: 'device', desc: 'This device: hardware and loaded models' },
  { name: 'invite', desc: 'Pair a device or invite a member' }
]
