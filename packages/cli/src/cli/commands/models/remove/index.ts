import { arg, summary } from 'paparam'
import { DEVICE, flags } from '../../../flags.js'
import { command } from '../../command.js'

export const remove = () =>
  command(
    'remove',
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('../models.js'))['models']>) =>
        import('../models.js').then((m) => m.models(...a))
    },
    summary('Delete a model from disk, refusing while it is loaded'),
    arg('<model>', 'The model to remove'),
    ...flags(DEVICE)
  )
