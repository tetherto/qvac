#!/usr/bin/env node
/**
 * actionlint gate for PR-edited workflow and composite-action files.
 *
 * No checked-in baseline: CI passes `git diff` output so only files this PR
 * touches are scanned, and only findings in the corruption classes below fail
 * the check (dangling needs, unparseable YAML, duplicate keys, empty `if:` from
 * a bare leading `!`, and similar). Pre-existing debt such as dead `npm-token`
 * inputs on publish jobs is ignored until those files are cleaned up separately.
 *
 * Usage:
 *   node .github/scripts/lint-workflows.mjs .github/workflows/on-pr-foo.yml ...
 *   node .github/scripts/lint-workflows.mjs --input report.txt
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const ACTIONLINT_FLAGS = ['-oneline', '-shellcheck=', '-pyflakes=']

function parseArgs(argv) {
  const args = { input: null, files: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i]
    else if (argv[i] === '--') {
      args.files.push(...argv.slice(i + 1))
      break
    } else if (argv[i].startsWith('-')) {
      throw new Error(`unknown argument: ${argv[i]}`)
    } else {
      args.files.push(...argv.slice(i))
      break
    }
  }
  return args
}

function existingWorkflowPaths(paths) {
  return paths.filter((relativePath) => {
    try {
      return statSync(resolve(repoRoot, relativePath)).isFile()
    } catch {
      return false
    }
  })
}

function runActionlint(files) {
  const result = spawnSync('actionlint', [...ACTIONLINT_FLAGS, ...files], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.error) {
    throw new Error(
      `could not run actionlint (${result.error.message}). Install it locally ` +
        'or pass --input with saved output.',
    )
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `actionlint exited ${result.status}: ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

/** Raw actionlint line: `path:line:col: message [rule]` */
function parseRawLines(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+?):(\d+):(\d+): (.*)$/)
      if (!match) return null
      return {
        file: match[1],
        line: Number(match[2]),
        col: Number(match[3]),
        message: match[4],
        raw: line,
      }
    })
    .filter(Boolean)
}

/**
 * Fail only on the YAML/job-graph corruption class the label-gate codemod
 * introduced. Everything else (dead npm-token inputs, matrix typos, empty choice
 * options on dispatch-only workflows) stays out of scope for this gate.
 */
function structuralFindings(parsed) {
  const byPos = new Map()
  for (const item of parsed) {
    const key = `${item.file}:${item.line}:${item.col}`
    if (!byPos.has(key)) byPos.set(key, [])
    byPos.get(key).push(item)
  }

  const out = []
  for (const item of parsed) {
    const rule = item.message.match(/\[[-a-z]+\]$/)?.[0] ?? ''
    const text = item.message.replace(/\[[-a-z]+\]$/, '').trim()

    if (rule === '[job-needs]') {
      out.push(item.raw)
      continue
    }

    if (rule === '[syntax-check]') {
      if (/could not parse as YAML/.test(text)) {
        out.push(item.raw)
        continue
      }
      if (/is duplicated/.test(text)) {
        out.push(item.raw)
        continue
      }
      if (/section should not be empty/.test(text)) {
        out.push(item.raw)
        continue
      }
      // Bare `if: !expr` — YAML reads `!` as a tag, leaving an empty condition.
      if (/string should not be empty/.test(text)) {
        const key = `${item.file}:${item.line}:${item.col}`
        const peers = byPos.get(key) ?? []
        if (
          peers.some(
            (p) =>
              p.message.includes('[expression]') &&
              /unexpected end of input/.test(p.message),
          )
        ) {
          out.push(item.raw)
        }
      }
    }
  }

  return [...new Set(out)]
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const files = existingWorkflowPaths(args.files)

  if (!args.input && files.length === 0) {
    console.log('lint-workflows: no workflow files to lint — skipping.')
    return
  }

  const raw = args.input
    ? readFileSync(resolve(repoRoot, args.input), 'utf8')
    : runActionlint(files)
  const parsed = parseRawLines(raw)
  const findings = structuralFindings(parsed)

  if (findings.length) {
    console.error(
      `actionlint structural gate failed (${findings.length} finding(s)):`,
    )
    for (const finding of findings) console.error(`  ${finding}`)
    process.exit(1)
  }

  const scope = args.input
    ? 'report'
    : `${files.length} changed file(s), ${parsed.length} finding(s) ignored as non-structural`
  console.log(`actionlint structural gate clean (${scope}).`)
}

try {
  main()
} catch (e) {
  console.error(`lint-workflows: ${e.message}`)
  process.exit(2)
}
