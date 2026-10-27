import { summary } from 'paparam'
import { DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'

export const logs = () =>
  command(
    'logs',
    {
      where: 'launcher',
      run: (...a: Parameters<(typeof import('./logs.js'))['runLogs']>) =>
        import('./logs.js').then((m) => m.runLogs(...a))
    },
    summary('Recent logs from assistant.log and harness.log; -f keeps following'),
    ...flags([...DEVICE, 'follow', 'tail'])
  )
