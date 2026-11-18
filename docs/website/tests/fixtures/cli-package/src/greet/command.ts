import type { Command } from 'commander'

export function registerGreetCommand(program: Command): void {
  const greet = program
    .command('greet')
    .description('Greet someone')
    .argument('<name>', 'Who to greet')
    .option('-l, --loud', 'Shout the greeting')
    .option('--times <n>', 'How many times', '1')
    .action(() => {})
  greet.command('back').description('Greet back').action(() => {})
  program.command('secret', { hidden: true }).action(() => {})
}
