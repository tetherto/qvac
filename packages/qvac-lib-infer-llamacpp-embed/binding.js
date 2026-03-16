const binding = require.addon()

// Dynamically-loaded GPU backend libraries (Vulkan, Metal, etc.) register
// static destructors that SIGSEGV during normal process exit when they
// reference the partially-destroyed ggml backend registry. Call _Exit() from
// the Bare 'exit' event (before the runtime dlclose's this addon) to skip
// static destructors entirely. The OS reclaims all process resources.
const Bare = require('bare-process')
Bare.on('exit', (code) => binding.forceExit(code))

module.exports = binding
