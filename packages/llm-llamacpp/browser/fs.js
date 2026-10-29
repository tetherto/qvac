// bare-fs stand-in for the browser build. The addon only touches the file
// system for sharded weight streaming and finetune checkpoints, neither of
// which the browser build supports.

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
