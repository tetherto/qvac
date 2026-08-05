const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// `@qvac/supervisor` runs in the application process on mobile, and it reaches
// EventEmitter through `ready-resource`. Hermes ships no Node standard library,
// so Metro has nothing to resolve `events` to. The shim is a faithful
// EventEmitter, which is all the supervisor needs.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  events: require.resolve('events')
}

module.exports = config
