import { arg, sloppy, summary } from 'paparam'
import { CHAT, DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'

const run = (...a: Parameters<(typeof import('./chat.js'))['runChat']>) =>
  import('./chat.js').then((m) => m.runChat(...a))

// the words are the first message, and flags may come between them
export const chat = (name = 'chat') =>
  command(
    name,
    { where: 'app', run },
    summary('Open chat; the words after it are your first message'),
    arg('[message]', 'Your first message'),
    sloppy({ args: true }),
    ...flags([...DEVICE, ...CHAT])
  )
