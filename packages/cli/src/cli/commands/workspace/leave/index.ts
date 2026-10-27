import { summary } from 'paparam'
import { DEVICE, flags } from '../../../flags.js'
import { command } from '../../command.js'

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
