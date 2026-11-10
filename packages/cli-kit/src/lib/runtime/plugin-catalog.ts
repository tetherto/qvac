// needs and wants name catalog ids or services; a service resolves to the platform's provider
const plugin = (
  id: string,
  exportName: string,
  fields: {
    name: string
    description: string
    needs?: string[]
    platforms?: string[]
    read?: string[]
    tools?: string[]
    recommended?: boolean
    provides?: string[]
    wants?: string[]
    setup?: string
    build?: string
    inject?: { quickjs: string }
    options?: { settings: string }
  }
) => ({
  id,
  use: `@qvac/harness/plugins/${id}`,
  export: exportName,
  needs: [],
  provides: [],
  tools: [],
  ...fields
})

export const PLUGIN_CATALOG = [
  plugin('coding', 'CodingPlugin', {
    name: 'Coding',
    description:
      'A persistent shell and background jobs (shell, shell_jobs) for real coding work, run inside the platform sandbox. Turning it on brings the sandbox with it.',
    needs: ['sandbox'],
    platforms: ['darwin', 'linux'],
    read: ['shell', 'shell_jobs'],
    tools: ['shell', 'shell_jobs'],
    recommended: true
  }),
  plugin('sandbox-macos', 'SeatbeltSandbox', {
    name: 'macOS sandbox',
    description:
      "Runs every shell line under Seatbelt (sandbox-exec) with the run's file and network policy. Provides the sandbox coding needs.",
    provides: ['sandbox'],
    wants: ['egress-proxy'],
    platforms: ['darwin']
  }),
  plugin('sandbox-linux', 'LinuxSandbox', {
    name: 'Linux sandbox',
    description:
      "Runs every shell line under bubblewrap (/usr/bin/bwrap) and seccomp with the run's policy. Provides the sandbox coding needs.",
    provides: ['sandbox'],
    platforms: ['linux']
  }),
  plugin('sandbox-windows', 'AppContainerSandbox', {
    name: 'Windows sandbox',
    description:
      "Runs exec's shell lines in an AppContainer through the shipped qvac-sandbox helper. It confines exec only; it does not serve the sandbox coding needs.",
    platforms: ['win32']
  }),
  plugin('sandbox-vm', 'VmShell', {
    name: 'VM sandbox',
    description: "Runs exec's shell lines in a barevisor VM with no network, disk or host mounts.",
    platforms: ['darwin', 'linux'],
    setup: 'options.image needs the kernel and initrd paths of a prebuilt guest'
  }),
  plugin('egress-proxy', 'EgressProxy', {
    name: 'Egress proxy',
    description:
      "A loopback HTTP proxy per session that lets a sandboxed line reach only the policy's hosts. The macOS sandbox uses it when present.",
    provides: ['egress-proxy']
  }),
  plugin('lsp', 'LspPlugin', {
    name: 'Language servers',
    description:
      'Definitions, references, symbols, hover and diagnostics (lsp) from local language servers. Finds typescript-language-server, pyright, gopls, rust-analyzer and clangd on PATH unless options.servers lists them.',
    build: 'lsp',
    read: ['lsp'],
    tools: ['lsp'],
    recommended: true
  }),
  plugin('quickjs', 'QuickJs', {
    name: 'QuickJS',
    description:
      'In-process JavaScript for exec (language: "javascript"): no files, network or modules.'
  }),
  plugin('code-mode', 'CodeMode', {
    name: 'Code mode',
    description:
      'run_code: one JavaScript body that calls the other tools as functions, each call approved as if made directly. Brings QuickJS with it.',
    needs: ['quickjs'],
    inject: { quickjs: 'quickjs' },
    read: ['run_code'],
    tools: ['run_code']
  }),
  plugin('command-hooks', 'CommandHooks', {
    name: 'Command hooks',
    description:
      'Runs the command hooks of a Claude Code settings.json (PreToolUse, PostToolUse, Stop, ...) on the harness hook phases.',
    build: 'command-hooks',
    options: { settings: '~/.claude/settings.json' }
  }),
  plugin('language-hint', 'LanguageHint', {
    name: 'Language hint',
    description:
      'Tells the model the language of a prompt that is not in English, with the prompt in English. Uses the built-in translation.',
    needs: ['translation']
  }),
  plugin('walkie-talkie', 'WalkieTalkie', {
    name: 'Walkie-talkie',
    description:
      'Two-way messages between agents and people on different machines over Hyperswarm (ask_team, team_send, team_wait).',
    tools: ['ask_team', 'team_send', 'team_wait'],
    setup: 'options.team (64 hex chars shared with the team) and options.name'
  })
]

// Loaded by the harness sidecar on every start; listed only to show what is already there.
export const BUILT_IN_PLUGINS = [
  {
    id: 'python',
    name: 'Python',
    builtIn: true,
    description: 'Python in Pyodide for exec (language: "python").',
    tools: []
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    builtIn: true,
    description: 'Routes exec at an Obsidian vault.',
    tools: []
  },
  {
    id: 'speech',
    name: 'Speech',
    builtIn: true,
    description: 'Speech to text and text to speech.',
    provides: ['speech'],
    tools: []
  },
  {
    id: 'translation',
    name: 'Translation',
    builtIn: true,
    description: 'On-device translation.',
    provides: ['translation'],
    tools: ['translate']
  },
  {
    id: 'weather',
    name: 'Weather',
    builtIn: true,
    description: 'Weather lookups.',
    tools: ['weather_lookup']
  },
  {
    id: 'web-search',
    name: 'Web search',
    builtIn: true,
    description: 'Web search.',
    tools: ['web_search']
  },
  {
    id: 'mcp',
    name: 'MCP',
    builtIn: true,
    description: 'mcp_call for the MCP servers skills document.',
    tools: ['mcp_call']
  },
  {
    id: 'image',
    name: 'Image',
    builtIn: true,
    description: 'Image generation, when an image model is configured.',
    tools: ['generate_image', 'edit_image']
  },
  {
    id: 'music',
    name: 'Music',
    builtIn: true,
    description: 'Music generation, when a music model is configured.',
    tools: ['generate_music']
  },
  {
    id: 'knowledge',
    name: 'Knowledge',
    builtIn: true,
    description: 'Search over indexed documents, when configured.',
    provides: ['knowledge'],
    tools: ['knowledge_search']
  }
]

export const catalogEntry = (id: string, catalog = PLUGIN_CATALOG) =>
  catalog.find((entry) => entry.id === id)

export const supports = (entry: { platforms?: string[] | undefined }, platform: string) =>
  !entry.platforms || entry.platforms.includes(platform)

export type CatalogPlugin = (typeof PLUGIN_CATALOG)[number]
