// Overrides on top of the built-in defaults; docs/config.md lists every key and the merge rules.
export default {
  // Existing SDK keys retain their original meaning.
  plugins: ['@qvac/sdk/llamacpp-completion/plugin'],
  core: {
    dataDir: '~/.qvac/cli',
    // 'auto' (the default) picks by memory; a name pins one.
    model: 'Qwen3.5-4B-Q4_K_M',
    autoDownloadModels: false,
    // Replaces the default (the project root, writable); the default policy widens to cover it.
    folders: [
      { path: '.', write: true },
      { path: '../shared-docs', write: false }
    ],
    agent: { approvalMode: 'ask' }
  },
  harness: {
    maxToolRounds: 30,
    llm: { contextSize: 16384 },
    // Merged by id with the defaults: lsp turned off, a plugin of your own added.
    plugins: [
      { id: 'lsp', enabled: false },
      { use: '../plugins/greeter.mjs', export: 'Greeter', read: ['greet'] }
    ],
    delegation: {
      slots: 1,
      maxExternal: 2,
      targets: [
        {
          name: 'claude',
          protocol: 'claude',
          command: 'claude',
          login: 'isolated'
        },
        {
          name: 'codex',
          protocol: 'codex',
          command: 'codex',
          login: 'isolated'
        }
      ]
    }
  },
  tui: { startPage: 'chat', theme: 'terminal', toolOutput: 'collapsed' }
}
