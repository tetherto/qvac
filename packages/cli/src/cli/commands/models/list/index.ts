import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
import { summary } from 'paparam'

export const list = () =>
  command(
    'list',
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('../models.js'))['models']>) =>
        import('../models.js').then((m) => m.models(...a))
    },
    summary('What is on disk and loaded, then what else suits this device'),
    ...flags(DEVICE)
  )
