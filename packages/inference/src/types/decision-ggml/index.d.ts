// @qvac/decision-ggml is an optional peer of the decision plugin, loaded with a
// dynamic import when a model loads, and is not installed for this package's
// own build and tests. The plugin types what it uses itself (DecisionAddon in
// plugins/builtin/llamacpp-decision/upstream.ts), so the module is declared
// opaque here.
declare module '@qvac/decision-ggml'
declare module '@qvac/decision-ggml/addonLogging'
