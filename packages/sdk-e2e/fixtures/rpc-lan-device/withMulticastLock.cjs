const { withMainActivity, withAndroidManifest, AndroidConfig } = require('@expo/config-plugins')

module.exports = (config) => {
  config = withAndroidManifest(config, (mod) => {
    AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults).$[
      'android:usesCleartextTraffic'
    ] = 'true'
    return mod
  })
  return withMainActivity(config, (mod) => {
    const marker = 'class MainActivity : ReactActivity() {'
    if (mod.modResults.contents.includes('qvacMulticastLock')) return mod
    if (!mod.modResults.contents.includes(marker))
      throw new Error('Unexpected test MainActivity layout')
    mod.modResults.contents = mod.modResults.contents.replace(
      marker,
      `${marker}
  private var qvacMulticastLock: android.net.wifi.WifiManager.MulticastLock? = null

  override fun onResume() {
    super.onResume()
    val wifi = applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as android.net.wifi.WifiManager
    val lock = qvacMulticastLock ?: wifi.createMulticastLock("qvac-rpc-lan-validation").also {
      it.setReferenceCounted(false)
      qvacMulticastLock = it
    }
    if (!lock.isHeld) lock.acquire()
    android.util.Log.i("QvacRpcLan", "multicast_lock held=\${lock.isHeld} action=resume elapsedMs=\${android.os.SystemClock.elapsedRealtime()}")
  }

  override fun onPause() {
    qvacMulticastLock?.let { if (it.isHeld) it.release() }
    android.util.Log.i("QvacRpcLan", "multicast_lock held=\${qvacMulticastLock?.isHeld ?: false} action=pause elapsedMs=\${android.os.SystemClock.elapsedRealtime()}")
    super.onPause()
  }
`
    )
    return mod
  })
}
