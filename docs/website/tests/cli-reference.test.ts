import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliAsMarkdown, commandsOf, openApiAsMarkdown, openApiOperations, usage, type CliData } from '../src/lib/api-reference/cli'

/**
 * A command-line product's reference comes from its own command tree and
 * OpenAPI document: the walker reads a Commander CLI without running it.
 */

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'cli-package')
const WALKER = path.join(import.meta.dirname, '..', 'scripts', 'api-reference', 'commander-walker.ts')

function walk(): { cli: CliData; openapi: Record<string, unknown> } {
  const run = spawnSync('bun', ['run', WALKER, 'src/index.ts', 'src/spec.ts#renderSpec'], { cwd: FIXTURE, encoding: 'utf-8' })
  if (run.status !== 0) throw new Error(run.stderr)
  return JSON.parse(run.stdout.trim().split('\n').at(-1)!)
}

describe('the command-tree walker', () => {
  const { cli, openapi } = walk()

  it('replays the entry without running it', () => {
    expect(cli.name).toBe('demo')
    expect(cli.description).toBe('A demo CLI')
  })

  it('reads every visible command, its arguments, and its options', () => {
    const paths = commandsOf(cli).map((command) => command.path)
    expect(paths).toEqual(['demo greet', 'demo greet back'])
    const greet = commandsOf(cli, 'demo greet')[0]
    expect(greet.arguments).toMatchObject([{ name: 'name', required: true, description: 'Who to greet' }])
    expect(greet.options.map((option) => option.flags)).toEqual(['-l, --loud', '--times <n>'])
    expect(greet.options[1]).toMatchObject({ description: 'How many times', default: '1' })
  })

  it('renders the OpenAPI document the product produces', () => {
    expect(openapi.openapi).toBe('3.1.0')
  })

  it('writes a usage line and a Markdown rendition', () => {
    const greet = commandsOf(cli, 'demo greet')[0]
    expect(usage(greet)).toBe('demo greet <name> [options] [command]')
    expect(cliAsMarkdown(cli, 'demo greet', true)).toContain('`--times <n>`: How many times (default "1")')
    expect(cliAsMarkdown(cli, 'demo greet', true)).not.toContain('demo greet back')
  })
})

describe('the OpenAPI reference', () => {
  const { openapi } = walk()

  it('reads each operation and resolves its request body', () => {
    const { reader, operations } = openApiOperations(openapi)
    expect(operations.map((operation) => `${operation.method} ${operation.path}`)).toEqual(['POST /v1/echo'])
    const shape = reader.shapeOf(operations[0].request!)
    expect(shape).toMatchObject({ kind: 'object', fields: [{ name: 'message', required: true, description: 'What to echo' }] })
  })

  it('renders operations as Markdown', () => {
    const markdown = openApiAsMarkdown(openapi)
    expect(markdown).toContain('### `POST /v1/echo`')
    expect(markdown).toContain('message: string // What to echo')
    expect(markdown).toContain('`200` The message')
  })
})
