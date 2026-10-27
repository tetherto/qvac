import { summary, description } from 'paparam'
import { DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'

export const serve = (name = 'serve') =>
  command(
    name,
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('./serve.js'))['serve']>) =>
        import('./serve.js').then((m) => m.serve(...a))
    },
    summary('Set up and run this device, no UI'),
    description`
      Runs Core with no UI and keeps this device serving until stopped.
      On first run in a terminal it asks for a device link to pair with one you have
      (get it there: Devices → Pair a device, or qvac invite), or enter to set it up on its own.
      Without a terminal it sets up on its own unless a flag says otherwise.
      A restart resumes, no questions. It exits 0 on Ctrl+C, SIGTERM, or when unpaired.`,
    ...flags([...DEVICE, 'device-join', 'create', 'join'])
  )
