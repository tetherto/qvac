import { DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'
import { summary } from 'paparam'
import { list } from './list/index.js'
import { pull } from './pull/index.js'
import { remove } from './remove/index.js'

export const models = () =>
  command(
    'models',
    {},
    summary('List, download or remove models'),
    ...flags(DEVICE),
    list(),
    pull(),
    remove()
  )
