// Aider's polyglot benchmark through the real `qvac -p`: what it scores is what the app does.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CODING_INSTRUCTIONS } from '../../dist/lib/runtime/agent-profile.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const REPO = 'https://github.com/Aider-AI/polyglot-benchmark'
const PINNED = '7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f'

// how each language runs its tests in the exercise folder
const TESTS = {
  python: ['python3', ['-m', 'unittest', 'discover', '-p', '*_test.py']],
  go: ['go', ['test', './...']],
  rust: ['cargo', ['test', '--quiet', '--', '--include-ignored']],
  cpp: [
    'sh',
    [
      '-c',
      'mkdir -p build && cd build && cmake -DEXERCISM_RUN_ALL_TESTS=1 .. >/dev/null && make 2>&1'
    ]
  ],
  javascript: ['sh', ['-c', 'node_modules/.bin/jest ./*']],
  // the first run on a machine fetches Gradle and JUnit into ~/.gradle; after that it is offline
  java: ['sh', ['-c', './gradlew test --offline -q 2>&1']]
}

// Exercism skips every test but the first; the score, and the agent, see all of them
const SKIPS = [
  [/\bxtest\(/g, 'test('],
  [/\bxit\(/g, 'it('],
  [/\bxdescribe\(/g, 'describe('],
  [/^\s*@Disabled\b.*$/gm, ''],
  [/^\s*#\[ignore\]\s*$/gm, '']
]

// one install of the test packages every JS exercise shares; `npm install` in it once
const JS_DEPS = path.join(ROOT, 'output/bench/js-deps')

const { values: opts } = parseArgs({
  options: {
    model: { type: 'string' },
    languages: { type: 'string', default: 'python,go,rust,cpp' },
    exercises: { type: 'string' },
    limit: { type: 'string' },
    tries: { type: 'string', default: '2' },
    reasoning: { type: 'string', default: 'on' },
    // the workflow alone, without the project's folder and test command
    plain: { type: 'boolean', default: false },
    disable: { type: 'string' },
    budget: { type: 'string' },
    cli: { type: 'string', default: ROOT },
    'data-dir': { type: 'string' },
    out: { type: 'string' },
    'timeout-min': { type: 'string', default: '20' }
  }
})

if (!opts.model || !opts['data-dir']) {
  console.error(
    'usage: node benchmarks/coding/polyglot.mjs --model <name> --data-dir <set-up qvac data dir> [...]'
  )
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = path.resolve(opts.out || path.join(ROOT, 'output/bench/runs', `${stamp}-${opts.model}`))
const bench = checkout(path.join(ROOT, 'output/bench/polyglot-benchmark'))
const config = path.join(out, 'qvac.config.json')
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(
  config,
  JSON.stringify({
    core: {
      model: opts.model,
      agent: {
        // plan thinks after the prompt and after a failed step only; the harness strips it
        reasoning: opts.reasoning === 'off' ? 'disabled' : 'enabled',
        disabledToolsets: opts.disable ? opts.disable.split(',') : [],
        // left out of the JSON when unset, so the CLI's own instructions apply
        instructions: opts.plain ? CODING_INSTRUCTIONS : undefined
      }
    },
    harness: {
      reasoningBudget: opts.budget === undefined ? undefined : Number(opts.budget),
      thinking: opts.reasoning === 'plan' ? 'plan' : undefined,
      plugins: sandboxCaches()
    }
  })
)
fs.writeFileSync(
  path.join(out, 'meta.json'),
  JSON.stringify({ ...opts, out, pinned: PINNED }, null, 2)
)

const chosen = exercises(bench)
console.log(`${chosen.length} exercises → ${out}`)
for (const exercise of chosen) {
  const row = solve(exercise)
  fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(row) + '\n')
  console.log(
    `${row.passed ? 'PASS' : 'fail'} ${exercise.language}/${exercise.name} try ${row.passedOn ?? '-'} · ${row.secs}s · ${row.calls} calls`
  )
}

summarize(path.join(out, 'results.jsonl'))

// Go's build cache and Gradle's home live outside the exercise, so the sandbox lets every line write there
function sandboxCaches() {
  const languages = opts.languages.split(',')
  const writable = [
    ...(languages.includes('go') ? [run('go', ['env', 'GOCACHE']).stdout.trim()] : []),
    ...(languages.includes('java') ? [path.join(os.homedir(), '.gradle')] : [])
  ]
  if (writable.length === 0) {
    return undefined
  }

  const id = process.platform === 'darwin' ? 'sandbox-macos' : 'sandbox-linux'

  return [{ id, options: { writable } }]
}

function checkout(dir) {
  if (!fs.existsSync(dir)) {
    run('git', ['clone', '-q', REPO, dir])
  }

  run('git', ['-C', dir, 'checkout', '-q', PINNED])

  return dir
}

function exercises(dir) {
  const wanted = opts.exercises ? new Set(opts.exercises.split(',')) : null
  const all = opts.languages.split(',').flatMap((language) => {
    const practice = path.join(dir, language, 'exercises/practice')
    return fs
      .readdirSync(practice)
      .sort()
      .map((name) => ({ language, name, source: path.join(practice, name) }))
  })
  const picked = all.filter(
    (e) => !wanted || wanted.has(e.name) || wanted.has(`${e.language}/${e.name}`)
  )

  return opts.limit ? spread(picked, Number(opts.limit)) : picked
}

// a limit takes from every language in turn, so a short run still covers each one
function spread(list, limit) {
  // not Map.groupBy, which Node 20 (the H100's) lacks
  const by = new Map()
  for (const e of list) by.set(e.language, [...(by.get(e.language) ?? []), e])
  const picked = []
  for (let i = 0; picked.length < limit && picked.length < list.length; i++) {
    for (const group of by.values()) {
      if (group[i] && picked.length < limit) {
        picked.push(group[i])
      }
    }
  }

  return picked
}

function solve({ language, name, source }) {
  const meta = JSON.parse(fs.readFileSync(path.join(source, '.meta/config.json'), 'utf8'))
  const work = path.join(out, 'work', language, name)
  fs.cpSync(source, work, { recursive: true, filter: (p) => !p.includes(`${path.sep}.meta`) })
  if (language === 'javascript') {
    shareModules(work)
  }

  unskip(work, meta.files.test)
  run('git', ['init', '-q'], { cwd: work })
  run('git', ['add', '-A'], { cwd: work })
  run('git', ['-c', 'user.email=bench@qvac', '-c', 'user.name=bench', 'commit', '-qm', 'start'], {
    cwd: work
  })

  const files = meta.files.solution.join(' ')
  const docs = ['instructions.md', 'instructions.append.md', 'introduction.md']
    .map((f) => path.join(source, '.docs', f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n\n')
  let prompt =
    `${docs}\n\n####\n\nUse the above instructions to modify the supplied files: ${files}\n` +
    `Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.\n` +
    `Only use standard libraries, don't suggest installing any packages.\n`

  const started = Date.now()
  const row = { language, name, passed: false, passedOn: null, tries: [], calls: 0 }
  for (let attempt = 1; attempt <= Number(opts.tries); attempt++) {
    const transcript = path.join(out, 'runs', language, `${name}.try${attempt}.jsonl`)
    let agent = ask(prompt, { work, transcript, resume: attempt > 1 })
    // a run that failed before its first call is the machine's, not the model's: once more
    if (agent.end === 'failed' && agent.calls === 0) {
      agent = {
        ...ask(prompt, { work, transcript, resume: attempt > 1 }),
        infraRetry: agent.reason
      }
    }

    restoreTests(work, meta.files.test)
    const test = runTests(language, work)
    row.calls += agent.calls
    row.tries.push({ ...agent, testsPassed: test.passed })
    if (test.passed) {
      row.passed = true
      row.passedOn = attempt
      break
    }

    prompt =
      `${test.output.slice(-4000)}\n\n####\n\nSee the testing errors above.\n` +
      `The tests are correct, don't try and change them.\nFix the code in ${files} to resolve the errors.\n`
  }

  row.secs = Math.round((Date.now() - started) / 1000)
  row.diff = run('git', ['diff', '--stat'], { cwd: work }).stdout.trim()

  return row
}

function ask(prompt, { work, transcript, resume }) {
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  const args = [
    path.join(opts.cli, 'dist/index.js'),
    '--data-dir',
    opts['data-dir'],
    '--config',
    config,
    '--yes',
    '--mode',
    'json',
    ...(resume ? ['--continue'] : ['--new']),
    '-p',
    // test output can start with a dash, which would read as a flag
    '--',
    prompt
  ]
  const started = Date.now()
  const r = spawnSync('node', args, {
    cwd: work,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Number(opts['timeout-min']) * 60000,
    maxBuffer: 1 << 28
  })
  fs.writeFileSync(transcript, (r.stdout || '') + (r.stderr ? `\n#stderr\n${r.stderr}` : ''))
  const events = (r.stdout || '').split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  const chunks = events.filter((e) => e.type === 'chunk').map((e) => e.chunk)
  const calls = new Set(
    chunks.filter((c) => c.type === 'tool-call').map((c) => c.toolCall?.id ?? c.id)
  )
  const status = chunks.filter((c) => c.type === 'run-status').at(-1)?.runStatus
  const end = events.find((e) => e.type === 'end')

  return {
    secs: Math.round((Date.now() - started) / 1000),
    calls: calls.size,
    end: end?.status ?? (r.error ? r.error.code : `exit ${r.status}`),
    reason: end?.reason ?? null,
    tokens: status?.metrics?.totalTokens ?? null
  }
}

function unskip(work, tests) {
  for (const file of tests.map((t) => path.join(work, t)).filter((f) => fs.existsSync(f))) {
    const text = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(
      file,
      SKIPS.reduce((t, [skip, run]) => t.replace(skip, run), text)
    )
  }
}

// a real copy, not a link the sandboxed shell could not follow; a clone on APFS costs nothing
function shareModules(work) {
  const modules = path.join(JS_DEPS, 'node_modules')
  if (!fs.existsSync(modules)) {
    throw new Error(`no JS test packages: run npm install in ${JS_DEPS}`)
  }

  run('cp', [
    process.platform === 'darwin' ? '-Rc' : '-al',
    modules,
    path.join(work, 'node_modules')
  ])
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n')
}

// the model may edit a test; the score is always against the original
function restoreTests(work, tests) {
  run('git', ['checkout', '-q', 'HEAD', '--', ...tests], { cwd: work })
}

function runTests(language, work) {
  const [command, args] = TESTS[language]
  const r = spawnSync(command, args, {
    cwd: work,
    encoding: 'utf8',
    timeout: 300000,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' }
  })

  return { passed: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (r.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}: ${r.stderr || r.error?.message}`)
  }

  return r
}

function summarize(file) {
  const rows = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const pct = (n) => `${((100 * n) / rows.length).toFixed(1)}%`
  const first = rows.filter((r) => r.passedOn === 1).length
  const any = rows.filter((r) => r.passed).length
  const secs = rows.reduce((s, r) => s + r.secs, 0)
  console.log(
    `\n${rows.length} exercises · pass@1 ${pct(first)} · pass@2 ${pct(any)} · ${Math.round(secs / rows.length)}s each · ${os.hostname()}`
  )
}
