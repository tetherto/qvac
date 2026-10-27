import { summary } from 'paparam'
import { DEVICE, flags } from '../../../flags.js'
import { command } from '../../command.js'

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
