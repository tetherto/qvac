// bare-fs stand-in for native-only JavaScript paths. Browser model files,
// including GGUF shards, are mounted directly by binding.browser.js.

function unsupported(name) {
  return () => {
    throw new Error(`fs.${name} is not supported in the browser build`)
  }
}

module.exports = {
  createReadStream: unsupported('createReadStream'),
  readdirSync: unsupported('readdirSync'),
  rmSync: unsupported('rmSync')
}
