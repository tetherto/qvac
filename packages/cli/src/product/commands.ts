export interface ProductCommand {
  name: string
  desc: string
  alias?: string
  args?: string
}
export const commands: ProductCommand[] = [
  { name: 'new', desc: 'Start a fresh conversation' },
  { name: 'resume', desc: 'Switch to another conversation', alias: 'chats' },
  { name: 'chats', desc: 'Switch conversation' },
  {
    name: 'model',
    desc: 'Choose the chat model · or all models to download and remove',
    args: '[name]'
  },
  { name: 'thinking', desc: 'Turn model reasoning on or off', args: '[on|off|default]' },
  { name: 'skills', desc: 'Turn skills on and off, connect accounts, add your own' },
  { name: 'tools', desc: 'Choose which toolsets the agent may use' },
  { name: 'permissions', desc: 'Ask before changes, or auto-approve · saved rules' },
  { name: 'plugins', desc: 'Harness plugins: coding shell, LSP, sandbox, code mode…' },
  { name: 'agent', desc: 'Name, instructions, model, thinking, context size' },
  { name: 'usage', desc: 'Context window use, speed and compaction' },
  { name: 'compact', desc: 'Summarise earlier turns to free context' },
  { name: 'knowledge', desc: 'Files this conversation can search · RAG and web' },
  { name: 'activity', desc: 'Recent tool activity' },
  { name: 'fork', desc: 'Branch into a new conversation: all of it, or from an earlier message' },
  { name: 'copy', desc: 'Copy the last answer' },
  {
    name: 'export',
    desc: 'Save this conversation as HTML or Markdown',
    args: '[path.html|path.md]'
  },
  { name: 'session', desc: 'This conversation: id, messages, model, context' },
  { name: 'name', desc: 'Rename this conversation', args: '<title>' },
  { name: 'attach', desc: 'Attach a file to this conversation', args: '<path>' },
  { name: 'context', desc: 'Project instructions loaded from AGENTS.md / CLAUDE.md' },
  { name: 'details', desc: 'Show or hide tool output' },
  { name: 'stop', desc: 'Stop the current run' },
  {
    name: 'folders',
    desc: 'Choose what this agent can read or edit',
    args: '[read|write|remove <path>]'
  },
  { name: 'reload', desc: 'Reload prompt templates, context files and the file list' },
  { name: 'config', desc: 'Active configuration' },
  { name: 'overview', desc: 'Workspace dashboard' },
  { name: 'device', desc: 'This device: hardware and loaded models' },
  { name: 'invite', desc: 'Pair a device or invite a member' },
  { name: 'hotkeys', desc: 'Keys and commands' },
  { name: 'help', desc: 'Keys and commands' },
  { name: 'quit', desc: 'Exit QV.AC' }
]

export function match(input: string, extra: ProductCommand[] = []) {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\n')) {
    return []
  }

  const all = [...commands.filter((c) => !c.alias), ...extra]
  const [head = '', ...rest] = input.slice(1).split(' ')
  const query = head.toLowerCase()
  if (rest.length) {
    return all.filter((c) => c.name === query)
  }

  return [
    ...all.filter((c) => c.name.startsWith(query)),
    ...all.filter((c) => !c.name.startsWith(query) && query && c.desc.toLowerCase().includes(query))
  ]
}

export function parse(input: string) {
  const text = input.trim().slice(1),
    space = text.search(/\s/)
  return space < 0
    ? { name: text.toLowerCase(), arg: '' }
    : { name: text.slice(0, space).toLowerCase(), arg: text.slice(space).trim() }
}
