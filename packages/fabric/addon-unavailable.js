'use strict'

// Resolution target of last resort for the "#binding" imports map. Reaching this
// module means neither a local prebuild nor the host's platform package was
// found, so loading it is always a failure — it throws on require.
const { PREBUILT_HOSTS, platformPackageName, runtimeHost } = require('./platform')

throw new Error(buildMessage())

function buildMessage () {
  const { platform, arch } = runtimeHost()
  const host = platform && arch ? `${platform}-${arch}` : 'unknown'
  const expected = platformPackageName(platform, arch)
  if (!expected) {
    return `@qvac/fabric has no prebuilt runtime for ${host}. ` +
      `Prebuilt hosts: ${PREBUILT_HOSTS.join(', ')}. Build from source with bare-make.`
  }
  return `@qvac/fabric has no installed runtime for ${host}: ${expected} is not installed. ` +
    'It ships as an os/cpu filtered optional dependency, which Yarn v1 and installs using ' +
    '--omit=optional drop. Reinstall with npm 7+, pnpm, bun, or Yarn Berry, or build from ' +
    'source with bare-make.'
}
