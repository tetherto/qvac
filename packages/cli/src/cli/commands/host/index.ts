import { DEVICE, flags, command } from '@qvac/cli-kit/launch'
import { summary } from 'paparam'
import { serve } from '../serve/index.js'

// qvac host serve is qvac serve, as older docs and scripts say it
export const host = () =>
  command('host', {}, summary('qvac host serve is qvac serve'), ...flags(DEVICE), serve())
