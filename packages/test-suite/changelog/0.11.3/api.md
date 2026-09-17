# 🔌 API Changes v0.11.3

## Bundle and verify only the current mobile build target's hosts

PR: [#4500](https://github.com/tetherto/qvac/pull/4500)

```ts
import {
  MOBILE_HOSTS_BY_PLATFORM,
  mobileHostsForPlatform
} from '@/expo/plugins/withMobileBundle'

mobileHostsForPlatform('android')
// ['android-arm64']

mobileHostsForPlatform('ios')
// ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']

MOBILE_HOSTS_BY_PLATFORM.android
// ['android-arm64']

mobileHostsForPlatform('web')
// throws: QVAC: withMobileBundle only supports android and ios builds, got "web"
```

---

