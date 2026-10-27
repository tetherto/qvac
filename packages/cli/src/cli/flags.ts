import type { LaunchOptions } from '../lib/types.js'
// Every flag qvac takes, once: commands name the ones they use, and each reads QVAC_<NAME> too.
import { flag } from 'paparam'

// [name, option key, short, takes a value, what it does]
const TABLE: Array<[string, keyof LaunchOptions, string | null, boolean, string]> = [
  ['data-dir', 'dataDir', null, true, 'Where this device keeps its state'],
  ['storage', 'dataDir', 's', true, 'Alias of --data-dir'],
  ['device-name', 'deviceName', null, true, 'Name this machine'],
  ['name', 'deviceName', null, true, 'Alias of --device-name'],
  [
    'account-name',
    'accountName',
    null,
    true,
    'Your account name, which people in your workspaces see'
  ],
  ['model', 'model', null, true, 'The chat model'],
  ['config', 'configFile', null, true, 'Read this qvac.config file'],
  ['join', 'join', null, true, 'Join a workspace with its member link (qvac://workspace/…)'],
  ['device-join', 'deviceJoin', null, true, 'Pair with one of your devices (qvac://device/…)'],
  ['mode', 'mode', null, true, 'text, json or rpc: plain text, JSON lines, a JSONL RPC session'],
  ['chat', 'chat', null, true, 'Continue this conversation'],
  ['tail', 'tail', null, true, 'Lines from the end of each log (default: 50)'],
  ['bootstrap', 'bootstrap', null, true, 'DHT bootstrap nodes, host:port,…, for a private network'],
  ['create', 'create', null, false, 'Also start a workspace, for a script that needs one now'],
  ['json', 'json', null, false, 'Machine-readable output'],
  ['non-interactive', 'nonInteractive', null, false, 'Never ask; fail with exit 2 instead'],
  ['yes', 'yes', 'y', false, 'Accept the defaults and confirm'],
  ['no-color', 'noColor', null, false, 'Plain output'],
  ['no-default-models', 'noDefaultModels', null, false, 'Do not download the default models'],
  ['skip-setup', 'skipSetup', null, false, 'Skip first-run setup'],
  ['fake-models', 'fakeModels', null, false, 'A stand-in model, for tests'],
  ['temp', 'temp', null, false, 'A throwaway device state'],
  ['print', 'print', 'p', false, 'Print one answer and exit (stdin goes first)'],
  ['continue', 'continue', 'c', false, 'Continue the latest conversation'],
  ['resume', 'resume', 'r', false, 'Pick a conversation first'],
  ['new', 'newChat', 'n', false, 'Start a fresh conversation'],
  ['follow', 'follow', 'f', false, 'Keep printing as the logs grow'],
  ['version', 'version', 'v', false, 'Print the version']
]

export const FLAGS = TABLE.map(([name, key, short, value, about]) => ({
  name,
  key,
  short,
  value,
  about
}))

const BY_NAME = new Map(FLAGS.map((f) => [f.name, f]))

// The flags every command that opens this device's state shares.
export const DEVICE = [
  'data-dir',
  'storage',
  'config',
  'temp',
  'json',
  'yes',
  'non-interactive',
  'no-color',
  'bootstrap',
  'skip-setup',
  'fake-models',
  'no-default-models',
  'model',
  'device-name',
  'name',
  'account-name'
]

export const CHAT = ['print', 'mode', 'chat', 'continue', 'resume', 'new']

// paparam flags for these names; --no-x is a flag of its own here, not x turned off
export function flags(names: string[]) {
  return [...new Set(names)].map((name) => {
    const f = BY_NAME.get(name)!
    const spec = [`--${f.name}`, f.short && `-${f.short}`].filter(Boolean).join('|')
    return flag(spec + (f.value ? ' <value>' : ''), f.about)
  })
}

// paparam files --no-x under x, and camel-cases the rest
export const paramKey = (f: FlagDefinition) => camel(f.name.replace(/^no-/, ''))
const camel = (name: string) => name.replace(/-(.)/g, (_, c: string) => c.toUpperCase())

export function envName(f: FlagDefinition) {
  return `QVAC_${f.name.toUpperCase().replaceAll('-', '_')}`
}

export type FlagDefinition = (typeof FLAGS)[number]
