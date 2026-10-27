import { arg, sloppy, summary } from 'paparam'
import { command } from '../command.js'

export const help = () =>
  command(
    'help',
    {
      where: 'launcher',
      run: (...a: Parameters<(typeof import('./help.js'))['runHelp']>) =>
        import('./help.js').then((m) => m.runHelp(...a))
    },
    summary('Commands and options; qvac help <command> for one'),
    arg('[command]', 'The command to explain'),
    sloppy({ args: true })
  )
