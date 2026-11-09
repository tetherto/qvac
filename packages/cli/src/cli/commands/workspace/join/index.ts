import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
import { arg, summary } from 'paparam'

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
