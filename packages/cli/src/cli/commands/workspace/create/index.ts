import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
import { summary } from 'paparam'

export const create = () =>
  command(
    'create',
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('../workspace.js'))['create']>) =>
        import('../workspace.js').then((m) => m.create(...a))
    },
    summary('Start a workspace with you as its admin; qvac invite --json prints its link'),
    ...flags(DEVICE)
  )
