import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
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
