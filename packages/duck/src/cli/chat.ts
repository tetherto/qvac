import type { ParsedCommand, LauncherKit, LaunchOptions } from '@qvac/cli-kit/launch'
import process from '#process'

// duck, duck "prompt", duck -p: the words are the first message, and the mode picks chat or print
export async function runChat({ words, options }: ParsedCommand, { app, usage }: LauncherKit) {
  if (words.length) {
    options.prompt = words.join(' ')
  }

  const problem = checkMode(options)
  if (problem) {
    usage(problem)
  }

  await app(options)
}

function checkMode(options: LaunchOptions) {
  if (options.mode && !['text', 'json', 'rpc'].includes(options.mode)) {
    return `unknown mode ${options.mode}. Use text, json or rpc.`
  }

  if (!options.mode && (options.print || (options.prompt && !process.stdout.isTTY))) {
    options.mode = 'text'
  }

  if (options.mode === 'rpc' && options.prompt) {
    return 'rpc mode takes prompts on stdin, not as arguments.'
  }

  if (options.mode && options.mode !== 'rpc') {
    options.stdinPiped = !process.stdin.isTTY
    if (!options.prompt && !options.stdinPiped) {
      return 'no prompt given. Pass -p "prompt" or pipe text on stdin.'
    }
  }

  if (options.prompt && !options.mode) {
    options.initialPrompt = options.prompt
  }

  if (!options.mode && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return 'duck needs a terminal. Use duck -p for one prompt, or --help.'
  }

  return null
}
