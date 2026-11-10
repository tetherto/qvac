import { DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'
import { summary } from 'paparam'
import { create } from './create/index.js'
import { join } from './join/index.js'
import { leave } from './leave/index.js'

export const workspace = () =>
  command(
    'workspace',
    {},
    summary('Start, join or leave a workspace'),
    ...flags(DEVICE),
    create(),
    join(),
    leave()
  )
