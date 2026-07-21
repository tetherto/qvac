export function generateWorkletHarness(bundleSpecifier: string) {
  const source = `\
import { Worklet } from 'react-native-bare-kit'
import { Asset } from 'expo-asset'
import bundle from ${JSON.stringify(bundleSpecifier)}

export default {
  async start(id, opts = {}, args = []) {
    const asset = Asset.fromModule(bundle)
    await asset.downloadAsync()
    const uri = asset.localUri ?? asset.uri
    const response = await fetch(uri)
    if (!response.ok) {
      throw new Error('Worklet bundle fetch failed (' + response.status + ')')
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const filename = id.toLowerCase() + '.bundle'
    const worklet = new Worklet(filename, opts)
    worklet.start('/' + filename, bytes, args)

    await new Promise((resolve) => setTimeout(resolve, 500))
    return { ipc: worklet.IPC, worklet }
  }
}
`
  const types = `\
declare const harness: {
  start(
    id: string,
    opts?: import('react-native-bare-kit').WorkletOptions,
    args?: string[]
  ): Promise<{
    ipc: import('react-native-bare-kit').Worklet['IPC']
    worklet: import('react-native-bare-kit').Worklet
  }>
}

export default harness
`

  return { source, types }
}

export const workletHosts = [
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator',
  'android-arm',
  'android-arm64',
  'android-ia32',
  'android-x64'
]
