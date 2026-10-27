import { arg, summary } from 'paparam'
import { DEVICE, flags } from '../../../flags.js'
import { command } from '../../command.js'

export const pull = () =>
  command(
    'pull',
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('../models.js'))['models']>) =>
        import('../models.js').then((m) => m.models(...a))
    },
    summary('Download a model, with its progress'),
    arg('<model>', 'A model name from qvac models list'),
    ...flags(DEVICE)
  )
