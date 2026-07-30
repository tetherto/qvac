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
//      moment either test is rescheduled. (Models a test reaches only through a
//      shared helper are not inferable statically — those live in the manifest
//      entry and rule 1 covers them.)
//
// Usage:
//   node scripts/validate-mobile-manifest.js          # check, exit 1 on failure
//   node scripts/validate-mobile-manifest.js --fix    # repin urls (rule 4)
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileManifestPath = path.join(repoRoot, 'test', 'mobile', 'model-manifest.json')
const testGroupsPath = path.join(repoRoot, 'test', 'mobile', 'test-groups.json')
const integrationManifestPath = path.join(integrationDir, 'models.manifest.json')

const PINNED_URL_RE = /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//

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
        `${testName}: prestage-ignore for ${m[1]} needs a reason ("// prestage-ignore: <model> — <why>")`
      )
    }
    ignored.add(m[1])
  }
  return ignored
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

  // Rule 1 — every grouped test is pre-staged.
  for (const [platform, groups] of Object.entries(testGroups)) {
    for (const [group, tests] of Object.entries(groups)) {
      for (const test of tests) {
        if (!mobileManifest[test]) {
          errors.push(
            `${platform}/${group}: ${test} has no model-manifest entry — its models would be ` +
              'downloaded on-device instead of pre-staged'
          )
        }
      }
    }
  }

  // Rules 2-4 — keys point at real tests, models are known and pinned.
  for (const [test, models] of Object.entries(mobileManifest)) {
    if (!known.has(test)) {
      errors.push(`${test}: no matching test/integration/*.test.js (stale manifest key?)`)
    }
    if (!Array.isArray(models) || models.length === 0) {
      errors.push(`${test}: manifest entry must be a non-empty array`)
      continue
    }
    for (const model of models) {
      const pinned = pinnedUrlFor(integrationManifest, model.name)
      if (!pinned) {
        errors.push(`${test}: ${model.name} is not in test/integration/models.manifest.json`)
        continue
      }
      if (!PINNED_URL_RE.test(pinned)) {
        errors.push(`${model.name}: models.manifest.json url is not commit-pinned (${pinned})`)
        continue
      }
      if (model.url !== pinned) {
        errors.push(
          `${test}: ${model.name} url is not the pinned models.manifest.json url. ` +
            `Run \`node scripts/validate-mobile-manifest.js --fix\`.\n` +
            `       have: ${model.url}\n       want: ${pinned}`
        )
      }
    }
  }

  // Rule 5 — models a grouped test names in its own source are declared in ITS
  // OWN entry. Deliberately not the shard-wide union: a sibling test staging
  // the same file would satisfy this check by coincidence, and the coincidence
  // evaporates the moment either test is moved to another shard — which is
  // exactly how three of the gaps this validator was written for stayed
  // invisible on main. Per-test is the only form that survives a rebalance.
  const grouped = new Set()
  for (const groups of Object.values(testGroups)) {
    for (const tests of Object.values(groups)) tests.forEach((t) => grouped.add(t))
  }
  for (const test of grouped) {
    const file = known.get(test)
    if (!file) continue
    const src = sources[file]
    const ignored = prestageIgnores(src, test, errors)
    const staged = new Set((mobileManifest[test] || []).map((m) => m.name))
    for (const name of modelNamesInSource(src)) {
      // Names absent from models.manifest.json are not downloadable models
      // (LoRA adapters and other artifacts the test writes itself), so there is
      // nothing to pre-stage.
      if (!pinnedUrlFor(integrationManifest, name)) continue
      if (ignored.has(name) || staged.has(name)) continue
      errors.push(
        `${test} references ${name} but its own manifest entry does not stage it ` +
          '(add it to the entry, or add a `// prestage-ignore:` marker). A sibling test in the ' +
          'same shard staging it does not count — that breaks as soon as either test moves.'
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

function readSources() {
  const sources = {}
  for (const file of fs.readdirSync(integrationDir).filter((f) => f.endsWith('.test.js'))) {
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
    console.error('❌ test/mobile/model-manifest.json is not a valid pre-stage map:')
    errors.forEach((e) => console.error(`   - ${e}`))
    process.exit(1)
  }

  const models = Object.values(mobileManifest).reduce((n, m) => n + m.length, 0)
  console.log(
    `✅ mobile pre-stage manifest is valid (${Object.keys(mobileManifest).length} tests, ` +
      `${models} pinned model refs)`
  )
}

if (require.main === module) main()

module.exports = { modelNamesInSource, prestageIgnores, repinUrls, toFunctionName, validate }
