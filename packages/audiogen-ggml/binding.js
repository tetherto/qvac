module.exports = loadAddon()

function loadAddon() {
  try {
    return require.addon()
  } catch (err) {
    return loadPlatformPackageAddon(err)
  }
}

function loadPlatformPackageAddon(cause) {
  try {
    return require('#host-addon')
  } catch (err) {
    if (err.cause === undefined) err.cause = cause
    throw err
  }
}
