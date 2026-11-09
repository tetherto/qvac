import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
import { summary } from 'paparam'

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
