import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
import { summary } from 'paparam'

export const leave = () =>
  command(
    'leave',
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('../workspace.js'))['leave']>) =>
        import('../workspace.js').then((m) => m.leave(...a))
    },
    summary('Unpair this device; your other devices keep everything. Stop qvac serve first'),
    ...flags(DEVICE)
  )
