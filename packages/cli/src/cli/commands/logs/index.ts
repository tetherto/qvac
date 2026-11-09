import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
import { summary } from 'paparam'

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
