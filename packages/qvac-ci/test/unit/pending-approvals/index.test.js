'use strict'

const test = require('brittle')
const { Command } = require('../../../lib/command')
// Must be required before the index module so both share the same cached object.
const helpers = require('../../../lib/commands/pending-approvals/helpers')

// pending-approvals/index exports a singleton Command instance.
// We test that it has the correct interface without actually running
// GitHub API calls — those are covered in pending-approvals-helpers.test.js.

test('pending-approvals — exports a Command instance', t => {
  const pa = require('../../../lib/commands/pending-approvals/index')
  t.ok(pa instanceof Command)
})

test('pending-approvals — has correct name', t => {
  const pa = require('../../../lib/commands/pending-approvals/index')
  t.is(pa.name, 'pending-approvals')
})

test('pending-approvals — declares required secrets', t => {
  const pa = require('../../../lib/commands/pending-approvals/index')
  const envVars = pa.secrets.map(s => s.envVar)
  t.ok(envVars.includes('GITHUB_TOKEN'))
  t.ok(envVars.includes('GITHUB_APP_ID'))
  t.ok(envVars.includes('GITHUB_PRIVATE_KEY'))
})

test('pending-approvals — toCommand() returns a paparam command object', t => {
  const pa = require('../../../lib/commands/pending-approvals/index')
  const cmd = pa.toCommand()
  t.ok(cmd !== null && typeof cmd === 'object', 'toCommand returns an object')
})

test('pending-approvals — _run() calls process.exit(1) when PR is not approved', async t => {
  const pa = require('../../../lib/commands/pending-approvals/index')

  // Stub all helpers so no real API calls happen
  const orig = {
    buildOctokit: helpers.buildOctokit,
    buildAppOctokit: helpers.buildAppOctokit,
    fetchReviews: helpers.fetchReviews,
    buildApprovalCounts: helpers.buildApprovalCounts,
    upsertPrComment: helpers.upsertPrComment
  }
  helpers.buildOctokit = () => ({})
  helpers.buildAppOctokit = async () => ({})
  helpers.fetchReviews = async () => []
  helpers.buildApprovalCounts = async () => ({ maintainer: 0, teamLead: 0, other: 0 })
  helpers.upsertPrComment = async () => {}

  const savedExit = process.exit
  let exitCode = null
  process.exit = (code) => { exitCode = code }

  const savedToken = process.env.GITHUB_TOKEN
  const savedAppId = process.env.GITHUB_APP_ID
  const savedKey = process.env.GITHUB_PRIVATE_KEY
  process.env.GITHUB_TOKEN = 'ghp_FAKE_TOKEN_FOR_TESTING_ONLY_12345678'
  process.env.GITHUB_APP_ID = '99999'
  process.env.GITHUB_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----'

  await pa._run({ 'pr-number': '1', repo: 'org/repo', 'maintainers-team': 'mgmt', 'team-leads-team': 'tl', 'min-approvals': '2' })

  t.is(exitCode, 1, 'should exit with code 1 when PR is not approved')

  process.exit = savedExit
  Object.assign(helpers, orig)
  process.env.GITHUB_TOKEN = savedToken || ''
  process.env.GITHUB_APP_ID = savedAppId || ''
  process.env.GITHUB_PRIVATE_KEY = savedKey || ''
  if (!savedToken) delete process.env.GITHUB_TOKEN
  if (!savedAppId) delete process.env.GITHUB_APP_ID
  if (!savedKey) delete process.env.GITHUB_PRIVATE_KEY
})

test('pending-approvals — _run() does not call process.exit when PR is approved', async t => {
  const pa = require('../../../lib/commands/pending-approvals/index')

  const orig = {
    buildOctokit: helpers.buildOctokit,
    buildAppOctokit: helpers.buildAppOctokit,
    fetchReviews: helpers.fetchReviews,
    buildApprovalCounts: helpers.buildApprovalCounts,
    upsertPrComment: helpers.upsertPrComment
  }
  helpers.buildOctokit = () => ({})
  helpers.buildAppOctokit = async () => ({})
  helpers.fetchReviews = async () => []
  helpers.buildApprovalCounts = async () => ({ maintainer: 1, teamLead: 0, other: 1 })
  helpers.upsertPrComment = async () => {}

  const savedExit = process.exit
  let exitCalled = false
  process.exit = () => { exitCalled = true }

  const savedToken = process.env.GITHUB_TOKEN
  const savedAppId = process.env.GITHUB_APP_ID
  const savedKey = process.env.GITHUB_PRIVATE_KEY
  process.env.GITHUB_TOKEN = 'ghp_FAKE_TOKEN_FOR_TESTING_ONLY_12345678'
  process.env.GITHUB_APP_ID = '99999'
  process.env.GITHUB_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----'

  await pa._run({ 'pr-number': '1', repo: 'org/repo', 'maintainers-team': 'mgmt', 'team-leads-team': 'tl', 'min-approvals': '2' })

  t.absent(exitCalled, 'should not call process.exit when PR is approved')

  process.exit = savedExit
  Object.assign(helpers, orig)
  process.env.GITHUB_TOKEN = savedToken || ''
  process.env.GITHUB_APP_ID = savedAppId || ''
  process.env.GITHUB_PRIVATE_KEY = savedKey || ''
  if (!savedToken) delete process.env.GITHUB_TOKEN
  if (!savedAppId) delete process.env.GITHUB_APP_ID
  if (!savedKey) delete process.env.GITHUB_PRIVATE_KEY
})

test('pending-approvals — _run() throws when required flags are missing', async t => {
  const pa = require('../../../lib/commands/pending-approvals/index')
  // Simulate: secrets are set, but --pr-number is not provided
  const savedToken = process.env.GITHUB_TOKEN
  const savedAppId = process.env.GITHUB_APP_ID
  const savedKey = process.env.GITHUB_PRIVATE_KEY
  process.env.GITHUB_TOKEN = 'ghp_FAKE_TOKEN_FOR_TESTING_ONLY_12345678'
  process.env.GITHUB_APP_ID = '99999'
  process.env.GITHUB_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----'

  await t.exception.all(
    async () => pa._run({}),
    'should throw when --pr-number is missing'
  )

  process.env.GITHUB_TOKEN = savedToken || ''
  process.env.GITHUB_APP_ID = savedAppId || ''
  process.env.GITHUB_PRIVATE_KEY = savedKey || ''
  if (!savedToken) delete process.env.GITHUB_TOKEN
  if (!savedAppId) delete process.env.GITHUB_APP_ID
  if (!savedKey) delete process.env.GITHUB_PRIVATE_KEY
})
