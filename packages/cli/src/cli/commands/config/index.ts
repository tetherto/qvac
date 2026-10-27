import { summary } from 'paparam'
import { DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'

export const config = () =>
  command(
    'config',
    {
      where: 'launcher',
      run: (...a: Parameters<(typeof import('./config.js'))['runConfig']>) =>
        import('./config.js').then((m) => m.runConfig(...a))
    },
    summary('The merged configuration, and where each value comes from'),
    ...flags(DEVICE)
  )
