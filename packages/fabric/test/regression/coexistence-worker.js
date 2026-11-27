'use strict'

// This intentionally loads explicit artifact paths, not installed npm versions.
// Keep the worker dependency-free so bare-sidecar can run it as well as Bare.
const [order, fabricFile, diffusionFile, diffusionBackends] = Bare.argv.slice(2)
let fabric
let diffusion
function loadFabric() {
  fabric = require.addon(fabricFile)
  const count = fabric.loadBackends()
  if (!(count > 0)) throw new Error('Fabric registered no backends')
  return count
}
function loadDiffusion() {
  diffusion = require.addon(diffusionFile)
  if (typeof diffusion.getExpectedEsrganBackendDevice !== 'function') {
    throw new Error('Rebuild diffusion: backend-selection diagnostic is missing')
  }
  // Loads the real diffusion backend set, but requires no downloaded model.
  const device = diffusion.getExpectedEsrganBackendDevice('cpu', diffusionBackends)
  if (typeof device !== 'string' || device.toLowerCase() !== 'cpu') {
    throw new Error('Diffusion CPU selection returned ' + device)
  }
}
let count
if (order === 'fabric-first') {
  count = loadFabric()
  loadDiffusion()
  if (fabric.loadBackends() !== count) {
    throw new Error('Fabric registry changed during first diffusion load')
  }
} else if (order === 'diffusion-first') {
  loadDiffusion()
  count = loadFabric()
} else {
  throw new Error('Unknown load order: ' + order)
}
loadDiffusion()
if (fabric.loadBackends() !== count) throw new Error('Fabric registry changed after diffusion call')
console.log(
  JSON.stringify({
    kind: 'ggml-coexistence',
    order,
    fabricBackends: count,
    diffusionDevice: 'CPU',
    hostExecutable: Bare.argv[0]
  })
)
