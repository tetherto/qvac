import { summary, description } from 'paparam'
import { DEVICE, flags } from '../../flags.js'
import { command } from '../command.js'

export const invite = () =>
  command(
    'invite',
    {
      where: 'core',
      run: (...a: Parameters<(typeof import('./invites.js'))['invite']>) =>
        import('./invites.js').then((m) => m.invite(...a))
    },
    summary("This device's link, to pair another device with it"),
    description`
      Prints this device's link and, on a terminal, its QR code. A new machine pairs with it:
      qvac serve --device-join <link>, or paste it when QV.AC sets up. --json adds the
      workspace's member link when there is one. Run it while qvac serve is stopped.`,
    ...flags(DEVICE)
  )
