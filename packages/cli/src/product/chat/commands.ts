import type { ProductCommand } from '../commands.js'

// The chat's slash commands, in the order the palette lists them.
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
  { name: 'reload', desc: 'Reload prompt templates, context files and the file list' }
]
