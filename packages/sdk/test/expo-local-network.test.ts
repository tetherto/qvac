import test from 'brittle'
import configPlugins from '@expo/config-plugins'
import withLocalNetwork from '@/expo/plugins/withLocalNetwork'

const { compileModsAsync } = configPlugins

test('Expo LAN configuration preserves app purpose text, adds permissions once and grants no entitlement', async (t) => {
  const makeConfig = () =>
    withLocalNetwork(
      withLocalNetwork({
        name: 'LAN test',
        slug: 'lan-test',
        ios: { infoPlist: { NSLocalNetworkUsageDescription: 'App purpose' } }
      })
    )
  const ios = await compileModsAsync(makeConfig(), {
    projectRoot: '/tmp',
    platforms: ['ios'],
    introspect: true
  })
  t.is(ios.ios?.infoPlist?.NSLocalNetworkUsageDescription, 'App purpose')
  t.absent(ios.ios?.entitlements?.['com.apple.developer.networking.multicast'])
  const android = await compileModsAsync(makeConfig(), {
    projectRoot: '/tmp',
    platforms: ['android'],
    introspect: true
  })
  const manifest = android._internal?.modResults?.android?.manifest
  // Introspection exposes the manifest through the mod result; permission config stays portable.
  const permissions = manifest.manifest['uses-permission'].map(
    (entry: { $: { 'android:name': string } }) => entry.$['android:name']
  )
  for (const name of ['INTERNET', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_MULTICAST_STATE']) {
    t.is(
      permissions.filter((permission: string) => permission === `android.permission.${name}`)
        .length,
      1
    )
  }
})
