import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
import { arg, summary } from 'paparam'

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
