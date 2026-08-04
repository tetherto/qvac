#!/usr/bin/env node
'use strict'
// Validate test/mobile/model-manifest.json — the Android Device Farm pre-stage
// map (mobile test function name -> the models that shard must already have on
// the device before the run starts).
//
// A missing or incomplete entry is NOT a hard error at runtime: the phone
// silently falls back to fetching the model from huggingface.co mid-test
// (ensureModel in test/integration/utils.js), which is precisely the network
// flakiness the pre-stage was built to remove. Nothing else checks this, so the
// rules are enforced here.
//
// Rules
//   1. every test named in test/mobile/test-groups.json has a manifest entry
//   2. every manifest key maps to a real test/integration/<name>.test.js
//   3. every model name resolves in test/integration/models.manifest.json — the
//      single source of truth for url + sha256 + bytes
//   4. every manifest url is byte-identical to that pinned, commit-hashed url.
//      `/resolve/main/` is a moving target and must never appear here.
//   5. every model a grouped test names literally in its OWN source appears in
//      its OWN manifest entry, unless the test opts out with a marker:
//        // prestage-ignore: <model.gguf> — <why it must not be pre-staged>
//      Per-test, never the shard-wide union: a sibling entry staging the same
//      file satisfies a union check by coincidence and stops doing so the
//      moment either test is rescheduled.
//   6. models a test reaches only through a shared helper are covered the same
//      way, via a named pre-stage set. The helper labels the model table:
//        // prestage-set: multimodal-default
//        const MULTIMODAL_MODEL_CONFIG = { llmModel: { modelName: '...' }, ... }
//      and the test declares which set it consumes:
//        // prestage-uses: multimodal-default — via setupMultimodalInference()
//      The file names are read out of the helper, so editing the helper's model
//      changes the expected set and mismatches the manifest entry. A test that
//      restated the file names instead would just be a second copy of the same
//      fact, going stale in the same commit.
//   7. a manifest entry must be anchored to code: a grouped test that names no
//      model in its own source and declares no pre-stage set has an entry
//      nothing can check, which is how rule 6's blind spot arises in the first
//      place.
//
// Usage:
//   node scripts/validate-mobile-manifest.js          # check, exit 1 on failure
//   node scripts/validate-mobile-manifest.js --fix    # repin urls (rule 4 only)
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileManifestPath = path.join(repoRoot, 'test', 'mobile', 'model-manifest.json')
const testGroupsPath = path.join(repoRoot, 'test', 'mobile', 'test-groups.json')
const integrationManifestPath = path.join(integrationDir, 'models.manifest.json')

const PINNED_URL_RE = /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//
const SET_NAME = '[a-z0-9][a-z0-9-]*'

// Every error is printed as "   - <text>"; continuation lines line up under it.
const INDENT = '\n       '
function problem(what, why, fix) {
  return `${what}${INDENT}why: ${why}${INDENT}fix: ${fix}`
}

// Mirror toFunctionName() in generate-mobile-integration-tests.js:
// "gemma4.test.js" -> "runGemma4Test".
function toFunctionName(fileName) {
  const parts = fileName
    .replace(/\.js$/, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
  return 'run' + parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

// Quoted bare GGUF file names in a source file. URLs are skipped (they contain
// a path separator) so only real model-name literals match, which is why this
// works on tests that build their download url from a template literal.
function modelNamesInSource(src) {
  const names = new Set()
  const re = /(['"`])([^'"`\s/]+\.gguf)\1/g
  let m
  while ((m = re.exec(src)) !== null) names.add(m[2])
  return names
}

// `// prestage-ignore: <model.gguf> — <reason>` opt-outs, reason required.
function prestageIgnores(src, testName, errors) {
  const ignored = new Set()
  const re = /prestage-ignore:\s*(\S+\.gguf)\s*(?:[—–-]\s*(.*))?/g
  let m
  while ((m = re.exec(src)) !== null) {
    if (!m[2] || !m[2].trim()) {
      errors.push(
        problem(
          `${testName}: prestage-ignore for ${m[1]} needs a reason`,
          'an unexplained opt-out is indistinguishable from an oversight, so the ' +
            'next reader cannot tell whether it is still true',
          `write \`// prestage-ignore: ${m[1]} — <why it must not be pre-staged>\``
        )
      )
    }
    ignored.add(m[1])
  }
  return ignored
}

// `src` with every comment body and string literal blanked out, positions
// preserved. Brace matching MUST run on this rather than on the raw source: a
// `}` inside a string or a comment would end the block early and silently drop
// the models declared after it — under-reporting, which is the exact failure
// this validator exists to prevent. Template literals are blanked whole; their
// `${...}` braces are balanced, so ignoring them cannot skew the count.
function blankStringsAndComments(src) {
  const out = src.split('')
  let i = 0
  const blank = (start, end) => {
    for (let k = start; k < end && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      blank(i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      blank(i, stop)
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      let k = i + 1
      while (k < src.length) {
        if (src[k] === '\\') k += 2
        else if (src[k] === c) break
        else k++
      }
      blank(i, Math.min(k + 1, src.length))
      i = Math.min(k + 1, src.length)
    } else {
      i++
    }
  }
  return out.join('')
}

// The `{ ... }` literal that follows `from`, brace-matched. Used to scope a
// `// prestage-set:` label to the model table it labels rather than the whole
// helper — a helper defines several tables and each test uses one of them.
// The range is found on the blanked source but sliced out of the original, so
// the caller still sees the quoted model names.
function braceBlockAfter(src, from) {
  const code = blankStringsAndComments(src)
  const open = code.indexOf('{', from)
  if (open === -1 || open - from > 400) return ''
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return ''
}

// `// prestage-set: <name>` definitions, across every source file.
function prestageSetDefs(sources, errors) {
  const sets = new Map()
  for (const file of Object.keys(sources).sort()) {
    const re = new RegExp(`prestage-set:\\s*(${SET_NAME})`, 'g')
    let m
    while ((m = re.exec(sources[file])) !== null) {
      const name = m[1]
      if (sets.has(name)) {
        errors.push(
          problem(
            `pre-stage set "${name}" is defined twice (${sets.get(name).file} and ${file})`,
            'the set a test resolves to would depend on file read order',
            'rename one of them'
          )
        )
        continue
      }
      sets.set(name, { file, block: braceBlockAfter(sources[file], m.index + m[0].length) })
    }
  }
  return sets
}

// `// prestage-uses: <name> — <reason>` declarations in one source, reason
// required so the indirection is written down at the call site.
function prestageUses(src, testName, errors) {
  const uses = new Set()
  const re = new RegExp(`prestage-uses:\\s*(${SET_NAME})\\s*(?:[—–-]\\s*(.*))?`, 'g')
  let m
  while ((m = re.exec(src)) !== null) {
    if (!m[2] || !m[2].trim()) {
      errors.push(
        problem(
          `${testName}: prestage-uses for "${m[1]}" needs a reason`,
          'the reason is what tells the next reader how the test reaches those ' +
            'models, which is not visible in this file',
          `write \`// prestage-uses: ${m[1]} — <how this test reaches the set>\``
        )
      )
    }
    uses.add(m[1])
  }
  return uses
}

function allPrestageUses(sources) {
  const used = new Set()
  const re = new RegExp(`prestage-uses:\\s*(${SET_NAME})`, 'g')
  for (const src of Object.values(sources)) {
    let m
    while ((m = re.exec(src)) !== null) used.add(m[1])
  }
  return used
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function pinnedUrlFor(integrationManifest, name) {
  const entry = integrationManifest.models && integrationManifest.models[name]
  if (!entry || !Array.isArray(entry.urls) || typeof entry.urls[0] !== 'string') return null
  return entry.urls[0]
}

function knownTestFunctions() {
  const known = new Map()
  for (const file of fs.readdirSync(integrationDir).filter((f) => f.endsWith('.test.js'))) {
    known.set(toFunctionName(file), file)
  }
  return known
}

function validate({ mobileManifest, testGroups, integrationManifest, sources }) {
  const errors = []
  const known = knownTestFunctions()
  const isModel = (name) => pinnedUrlFor(integrationManifest, name) !== null

  // Rule 1 — every grouped test is pre-staged.
  for (const [platform, groups] of Object.entries(testGroups)) {
    for (const [group, tests] of Object.entries(groups)) {
      for (const test of tests) {
        if (!mobileManifest[test]) {
          errors.push(
            problem(
              `${platform}/${group}: ${test} has no model-manifest entry`,
              'the shard pre-stages nothing for it, so the phone downloads its ' +
                "models mid-test over Device Farm's network instead",
              `add "${test}": [{ "name": "<model.gguf>" }] to ` +
                'test/mobile/model-manifest.json, then run ' +
                '`node scripts/validate-mobile-manifest.js --fix` to fill in the pinned urls'
            )
          )
        }
      }
    }
  }

  // Rules 2-4 — keys point at real tests, models are known and pinned.
  for (const [test, models] of Object.entries(mobileManifest)) {
    if (!known.has(test)) {
      errors.push(
        problem(
          `${test}: no matching test/integration/*.test.js (stale manifest key?)`,
          'nothing runs under that name, so the entry is dead weight carried into ' +
            'every shard that greps for it',
          'delete the key, or rename it to match its test file ' +
            '(gemma4.test.js -> runGemma4Test)'
        )
      )
    }
    if (!Array.isArray(models) || models.length === 0) {
      errors.push(
        problem(
          `${test}: manifest entry must be a non-empty array`,
          'an empty entry reads as "this test needs no models", which is never true',
          'list the models, or remove the key entirely'
        )
      )
      continue
    }
    for (const model of models) {
      const pinned = pinnedUrlFor(integrationManifest, model.name)
      if (!pinned) {
        errors.push(
          problem(
            `${test}: ${model.name} is not in test/integration/models.manifest.json`,
            'the pre-stage resolves every download from that file by name, so an ' +
              'unknown name is skipped and the model is fetched on-device instead',
            `add ${model.name} to models.manifest.json (url + sha256 + bytes), or ` +
              'fix the spelling here'
          )
        )
        continue
      }
      if (!PINNED_URL_RE.test(pinned)) {
        errors.push(
          problem(
            `${model.name}: models.manifest.json url is not commit-pinned (${pinned})`,
            '/resolve/main/ moves — a re-tagged repo silently changes the bytes ' +
              'every device downloads',
            'repin it to a 40-char commit sha in test/integration/models.manifest.json'
          )
        )
        continue
      }
      if (model.url !== pinned) {
        errors.push(
          problem(
            `${test}: ${model.name} url is not the pinned models.manifest.json url` +
              `${INDENT}have: ${model.url}${INDENT}want: ${pinned}`,
            'a url here that disagrees with the pinned one misleads every reader ' +
              'about what actually gets pushed to the device',
            'run `node scripts/validate-mobile-manifest.js --fix`'
          )
        )
      }
    }
  }

  // Rules 5-7 — per-test coverage of the models a test actually reaches.
  //
  // Deliberately not the shard-wide union: a sibling test staging the same file
  // would satisfy a union check by coincidence, and the coincidence evaporates
  // the moment either test is moved to another shard — which is exactly how
  // three of the gaps this validator was written for stayed invisible on main.
  const sets = prestageSetDefs(sources, errors)
  const setModels = new Map()
  for (const [name, def] of sets) {
    const models = new Set([...modelNamesInSource(def.block)].filter(isModel))
    setModels.set(name, models)
    if (models.size === 0) {
      errors.push(
        problem(
          `${def.file}: pre-stage set "${name}" resolves to no known models`,
          'an empty set silently disables the coverage check for every test that ' +
            'declares it — the failure mode the set mechanism exists to close',
          'the `// prestage-set:` comment must sit immediately above the object ' +
            'literal holding the modelName fields, and those names must exist in ' +
            'test/integration/models.manifest.json'
        )
      )
    }
  }
  const usedSets = allPrestageUses(sources)
  for (const [name, def] of sets) {
    if (usedSets.has(name)) continue
    errors.push(
      problem(
        `${def.file}: pre-stage set "${name}" is defined but no test declares it`,
        'a set nothing consumes checks nothing; usually the consuming marker has ' +
          'a typo in the set name',
        `add \`// prestage-uses: ${name} — <how the test reaches it>\` to the ` +
          'consuming test, or drop the label'
      )
    )
  }

  const grouped = new Set()
  for (const groups of Object.values(testGroups)) {
    for (const tests of Object.values(groups)) tests.forEach((t) => grouped.add(t))
  }
  for (const test of grouped) {
    const file = known.get(test)
    if (!file) continue
    const src = sources[file]
    const ignored = prestageIgnores(src, test, errors)
    const uses = prestageUses(src, test, errors)
    const staged = new Set((mobileManifest[test] || []).map((m) => m.name))

    // Names absent from models.manifest.json are not downloadable models (LoRA
    // adapters and other artifacts the test writes itself), so there is nothing
    // to pre-stage.
    const own = new Set([...modelNamesInSource(src)].filter(isModel))

    // Rule 6 — expand each declared set, reading the names from the helper.
    const expected = new Map()
    for (const name of own) expected.set(name, null)
    for (const name of uses) {
      if (!sets.has(name)) {
        const listing = [...sets.keys()].sort().map((s) => `${s} (${sets.get(s).file})`)
        errors.push(
          problem(
            `${file}: \`prestage-uses: ${name}\` names an unknown pre-stage set`,
            'the declaration checks nothing, so this test is back to having an ' +
              'unanchored manifest entry',
            `use one of: ${listing.join(', ') || '(none defined yet)'} — or label the ` +
              `model table in the helper with \`// prestage-set: ${name}\` ` +
              'immediately above its object literal'
          )
        )
        continue
      }
      for (const model of setModels.get(name)) if (!expected.has(model)) expected.set(model, name)
    }

    // Rule 7 — an entry no rule can check is the blind spot, not a pass.
    if (staged.size > 0 && expected.size === 0) {
      errors.push(
        problem(
          `${test} stages ${staged.size} model(s) but names none of them, in its own ` +
            'source or via a pre-stage set',
          'nothing ties the entry to the code, so when the helper it uses changes ' +
            'model the entry goes stale silently: the pre-stage pushes the old file ' +
            'and the phone downloads the new one mid-test',
          'label the model table in the helper it uses with `// prestage-set: <name>` ' +
            `and add \`// prestage-uses: <name> — <how ${file} reaches it>\` here`
        )
      )
    }

    // Rule 5/6 — everything expected must be in THIS test's own entry.
    for (const [name, viaSet] of expected) {
      if (ignored.has(name) || staged.has(name)) continue
      const via = viaSet
        ? `which it reaches through pre-stage set "${viaSet}" (${sets.get(viaSet).file})`
        : 'which it names directly'
      errors.push(
        problem(
          `${test} does not stage ${name}, ${via}`,
          'the phone downloads it mid-test instead. A sibling test in the same ' +
            'shard staging it does not count — that breaks as soon as either test moves',
          `add { "name": "${name}" } to the "${test}" entry and run ` +
            '`node scripts/validate-mobile-manifest.js --fix`, or add ' +
            `\`// prestage-ignore: ${name} — <why>\` to ${file} if it must not be pre-staged`
        )
      )
    }
  }

  return errors
}

function repinUrls(mobileManifest, integrationManifest) {
  let changed = 0
  for (const models of Object.values(mobileManifest)) {
    for (const model of models) {
      const pinned = pinnedUrlFor(integrationManifest, model.name)
      if (pinned && model.url !== pinned) {
        model.url = pinned
        changed++
      }
    }
  }
  return changed
}

// Every .js under test/integration, not just *.test.js: pre-stage sets are
// defined in the shared helpers (_image-common.js, _vlm-image-perf.js).
function readSources() {
  const sources = {}
  for (const file of fs.readdirSync(integrationDir).filter((f) => f.endsWith('.js'))) {
    sources[file] = fs.readFileSync(path.join(integrationDir, file), 'utf8')
  }
  return sources
}

function main() {
  const mobileManifest = readJson(mobileManifestPath)
  const testGroups = readJson(testGroupsPath)
  const integrationManifest = readJson(integrationManifestPath)

  if (process.argv.includes('--fix')) {
    const changed = repinUrls(mobileManifest, integrationManifest)
    fs.writeFileSync(mobileManifestPath, JSON.stringify(mobileManifest, null, 2) + '\n')
    console.log(`[model-manifest] repinned ${changed} url(s)`)
  }

  const errors = validate({
    mobileManifest,
    testGroups,
    integrationManifest,
    sources: readSources()
  })

  if (errors.length > 0) {
    console.error(
      `❌ test/mobile/model-manifest.json is not a valid pre-stage map ` +
        `(${errors.length} problem${errors.length === 1 ? '' : 's'}).`
    )
    console.error(
      '   Each Android shard pre-stages exactly the models its tests declare; ' +
        'anything missing is\n   downloaded on the phone mid-test instead. ' +
        'See test/mobile/README.md for the rules.\n'
    )
    errors.forEach((e) => console.error(`   - ${e}\n`))
    process.exit(1)
  }

  const models = Object.values(mobileManifest).reduce((n, m) => n + m.length, 0)
  const sets = prestageSetDefs(readSources(), []).size
  console.log(
    `✅ mobile pre-stage manifest is valid (${Object.keys(mobileManifest).length} tests, ` +
      `${models} pinned model refs, ${sets} pre-stage sets)`
  )
}

if (require.main === module) main()

module.exports = {
  braceBlockAfter,
  modelNamesInSource,
  prestageIgnores,
  prestageSetDefs,
  prestageUses,
  repinUrls,
  toFunctionName,
  validate
}
