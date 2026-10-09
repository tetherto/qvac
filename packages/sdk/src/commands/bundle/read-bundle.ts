import { promises as fsp } from 'node:fs'
import Bundle from 'bare-bundle'

// The JavaScript wrappers bare-stow writes around an encoded bundle.
const ENCODED_PREFIXES = ['module.exports = ', 'export default ']

export async function readBundle(bundlePath: string): Promise<Bundle> {
  const data = await fsp.readFile(bundlePath)

  for (const prefix of ENCODED_PREFIXES) {
    if (data.subarray(0, prefix.length).toString() === prefix) {
      return Bundle.from(JSON.parse(data.subarray(prefix.length).toString()) as string)
    }
  }

  return Bundle.from(data)
}
