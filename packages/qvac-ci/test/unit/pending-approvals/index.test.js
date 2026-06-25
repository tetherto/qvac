import test from 'brittle'
import { Command } from '../../../lib/command.js'
// Import helpers before the index module — both share the same ESM module instance,
// so property mutations on the helpers object are visible inside _run().
import { helpers } from '../../../lib/commands/pending-approvals/helpers.js'
import pa from '../../../lib/commands/pending-approvals/index.js'

// pending-approvals/index exports a singleton Command instance.
// We test that it has the correct interface without actually running
// GitHub API calls — those are covered in pending-approvals-helpers.test.js.

test('pending-approvals — exports a Command instance', t => {
  t.ok(pa instanceof Command)
})

test('pending-approvals — has correct name', t => {
  t.is(pa.name, 'pending-approvals')
})

test('pending-approvals — declares required secrets', t => {
  const envVars = pa.secrets.map(s => s.envVar)
  t.ok(envVars.includes('GITHUB_TOKEN'))
  t.ok(envVars.includes('GITHUB_APP_ID'))
  t.ok(envVars.includes('GITHUB_PRIVATE_KEY'))
})

test('pending-approvals — toCommand() returns a CLI command object', t => {
  const cmd = pa.toCommand()
  t.ok(cmd !== null && typeof cmd === 'object', 'toCommand returns an object')
})

test('pending-approvals — _run() writes pending message to stdout when PR is not approved', async t => {
  const orig = {
    buildOctokit: helpers.buildOctokit,
    buildAppOctokit: helpers.buildAppOctokit,
    fetchReviews: helpers.fetchReviews,
    buildApprovalCounts: helpers.buildApprovalCounts,
    upsertPrComment: helpers.upsertPrComment
  }
  helpers.buildOctokit = async () => ({})
  helpers.buildAppOctokit = async () => ({})
  helpers.fetchReviews = async () => []
  helpers.buildApprovalCounts = async () => ({ maintainer: 0, teamLead: 0, other: 0 })
  helpers.upsertPrComment = async () => {}

  let output = ''
  const savedWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => { output += chunk; return true }

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

  t.ok(output.includes('pending approval'), 'should write pending message to stdout')
  t.absent(exitCalled, 'should not call process.exit')

  process.stdout.write = savedWrite
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
  const orig = {
    buildOctokit: helpers.buildOctokit,
    buildAppOctokit: helpers.buildAppOctokit,
    fetchReviews: helpers.fetchReviews,
    buildApprovalCounts: helpers.buildApprovalCounts,
    upsertPrComment: helpers.upsertPrComment
  }
  helpers.buildOctokit = async () => ({})
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
