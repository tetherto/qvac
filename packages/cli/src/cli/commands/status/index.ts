import { summary } from 'paparam'
import { DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'

export const status = () =>
  command(
    'status',
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('./status.js'))['status']>) =>
        import('./status.js').then((m) => m.status(...a))
    },
    summary('This device, its workspace, peers, the models loaded and where state lives'),
    ...flags(DEVICE)
  )
