// Mimics the failure shape that went green on Device Farm: the module body
// completes, but a promise rejects outside the awaited chain (a model load that
// errors instead of crashing). brittle's tally never sees it — only the
// runtime's unhandledRejection handler does.
Promise.reject(new Error('[MtmdLlm] Failed to load vision model'))
export default true
