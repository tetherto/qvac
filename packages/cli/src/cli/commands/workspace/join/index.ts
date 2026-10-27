import { arg, summary } from 'paparam'
import { DEVICE, flags } from '../../../flags.js'
import { command } from '../../command.js'

export const join = () =>
  command(
    'join',
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('../workspace.js'))['join']>) =>
        import('../workspace.js').then((m) => m.join(...a))
    },
    summary('Join with a link: qvac://workspace/ adds you, qvac://device/ pairs this machine'),
    arg('<link>', 'A qvac://workspace/ or qvac://device/ link'),
    ...flags(DEVICE)
  )
