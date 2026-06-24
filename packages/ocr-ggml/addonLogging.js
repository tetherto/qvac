module.exports = {
  get setLogger () { return require('./binding').setLogger },
  get releaseLogger () { return require('./binding').releaseLogger }
}
