import { summary } from 'paparam'
import { DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'
import { serve } from '../serve/index.js'

// qvac host serve is qvac serve, as older docs and scripts say it
export const host = () =>
  command('host', {}, summary('qvac host serve is qvac serve'), ...flags(DEVICE), serve())
