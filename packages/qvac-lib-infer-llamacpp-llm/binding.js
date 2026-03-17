const binding = require.addon()

// Dynamically-loaded GPU backend libraries (Vulkan, Metal, etc.) register
// static destructors that SIGSEGV during normal process exit. Explicitly
// unload them here (while ggml state is still alive) before Bare dlclose's
// the addon.
const Bare = require('bare-process')
Bare.on('exit', () => binding.shutdownBackends())

module.exports = binding
