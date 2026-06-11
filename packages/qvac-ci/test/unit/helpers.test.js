import test from 'brittle'
import {
  validateRequiredEnv,
  validatePrNumber,
  validateRepo,
  validateTeamSlug
} from '../../lib/helpers.js'
import { Sanitizer } from '../../lib/sanitizer.js'
import { GitHubSanitizer } from '../../lib/commands/pending-approvals/helpers.js'

const ghSanitizer = new GitHubSanitizer()

// Sanitizer (base — passthrough)

test('Sanitizer — redact returns the value unchanged', t => {
  const s = new Sanitizer()
  t.is(s.redact('hello world'), 'hello world')
  t.is(s.redact(null), null)
  t.is(s.redact(42), 42)
})

test('Sanitizer — sanitizeError returns error message unchanged', t => {
  const s = new Sanitizer()
  t.is(s.sanitizeError(new Error('oops')), 'oops')
})

test('Sanitizer — sanitizeError coerces non-Error to string', t => {
  const s = new Sanitizer()
  t.is(typeof s.sanitizeError(42), 'string')
})

// GitHubSanitizer — redact

test('GitHubSanitizer.redact — leaves plain strings unchanged', t => {
  t.is(ghSanitizer.redact('hello world'), 'hello world')
})

test('GitHubSanitizer.redact — masks GitHub PAT (ghp_)', t => {
  const input = 'Authorization: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
  t.ok(ghSanitizer.redact(input).includes('[REDACTED]'))
  t.absent(ghSanitizer.redact(input).includes('ghp_'))
})

test('GitHubSanitizer.redact — masks GitHub app token (ghs_)', t => {
  const input = 'token: ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
  t.ok(ghSanitizer.redact(input).includes('[REDACTED]'))
  t.absent(ghSanitizer.redact(input).includes('ghs_'))
})

test('GitHubSanitizer.redact — masks PEM private key block', t => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
  const result = ghSanitizer.redact('key: ' + pem)
  t.ok(result.includes('[REDACTED]'))
  t.absent(result.includes('BEGIN RSA PRIVATE KEY'))
})

test('GitHubSanitizer.redact — handles non-string input safely', t => {
  t.is(ghSanitizer.redact(null), null)
  t.is(ghSanitizer.redact(42), 42)
})

// GitHubSanitizer — sanitizeError (inherited template method)

test('GitHubSanitizer.sanitizeError — returns message only, not stack', t => {
  const err = new Error('something went wrong')
  const result = ghSanitizer.sanitizeError(err)
  t.is(result, 'something went wrong')
  t.absent(result.includes('at '))
})

test('GitHubSanitizer.sanitizeError — redacts secrets in error message', t => {
  const err = new Error('failed with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')
  const result = ghSanitizer.sanitizeError(err)
  t.ok(result.includes('[REDACTED]'))
  t.absent(result.includes('ghp_'))
})

test('GitHubSanitizer.sanitizeError — handles non-Error values', t => {
  t.is(typeof ghSanitizer.sanitizeError('plain string'), 'string')
  t.is(typeof ghSanitizer.sanitizeError(42), 'string')
})

// validateRequiredEnv

test('validateRequiredEnv — passes when all vars are set', t => {
  process.env.TEST_VAR_A = 'value-a'
  process.env.TEST_VAR_B = 'value-b'
  t.execution(() => validateRequiredEnv(['TEST_VAR_A', 'TEST_VAR_B']))
  delete process.env.TEST_VAR_A
  delete process.env.TEST_VAR_B
})

test('validateRequiredEnv — throws listing missing names only', t => {
  delete process.env.TEST_MISSING_VAR
  try {
    validateRequiredEnv(['TEST_MISSING_VAR'])
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('TEST_MISSING_VAR'))
  }
})

test('validateRequiredEnv — lists all missing vars in one error', t => {
  delete process.env.MISSING_ONE
  delete process.env.MISSING_TWO
  try {
    validateRequiredEnv(['MISSING_ONE', 'MISSING_TWO'])
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('MISSING_ONE'))
    t.ok(err.message.includes('MISSING_TWO'))
  }
})

test('validateRequiredEnv — does not include env var values in error', t => {
  process.env.PARTIAL_VAR = 'secret-value'
  delete process.env.OTHER_MISSING
  try {
    validateRequiredEnv(['PARTIAL_VAR', 'OTHER_MISSING'])
    t.fail('should have thrown')
  } catch (err) {
    t.absent(err.message.includes('secret-value'))
  }
  delete process.env.PARTIAL_VAR
})

// validatePrNumber

test('validatePrNumber — returns a number for a valid string', t => {
  const result = validatePrNumber('42')
  t.is(result, 42)
  t.is(typeof result, 'number')
})

test('validatePrNumber — accepts a numeric value directly', t => {
  t.is(validatePrNumber(99), 99)
})

test('validatePrNumber — throws for zero', async t => {
  await t.exception.all(async () => validatePrNumber('0'))
})

test('validatePrNumber — throws for negative numbers', async t => {
  await t.exception.all(async () => validatePrNumber('-5'))
})

test('validatePrNumber — throws for non-numeric string', async t => {
  await t.exception.all(async () => validatePrNumber('abc'))
})

test('validatePrNumber — throws for empty string', async t => {
  await t.exception.all(async () => validatePrNumber(''))
})

test('validatePrNumber — throws for undefined', async t => {
  await t.exception.all(async () => validatePrNumber(undefined))
})

// validateRepo

test('validateRepo — returns owner and repo for valid input', t => {
  const result = validateRepo('owner/my-repo')
  t.is(result.owner, 'owner')
  t.is(result.repo, 'my-repo')
})

test('validateRepo — accepts dots and underscores', t => {
  const result = validateRepo('my.org/repo_name.js')
  t.is(result.owner, 'my.org')
  t.is(result.repo, 'repo_name.js')
})

test('validateRepo — throws for missing slash', async t => {
  await t.exception.all(async () => validateRepo('noslash'))
})

test('validateRepo — throws for empty string', async t => {
  await t.exception.all(async () => validateRepo(''))
})

test('validateRepo — throws for undefined', async t => {
  await t.exception.all(async () => validateRepo(undefined))
})

test('validateRepo — throws for invalid characters', async t => {
  await t.exception.all(async () => validateRepo('owner/<script>'))
})

test('validateRepo — throws for double slash', async t => {
  await t.exception.all(async () => validateRepo('owner//repo'))
})

// validateTeamSlug

test('validateTeamSlug — returns slug for valid input', t => {
  t.is(validateTeamSlug('my-team', '--maintainers-team'), 'my-team')
  t.is(validateTeamSlug('Team1', '--team-leads-team'), 'Team1')
})

test('validateTeamSlug — accepts letters, digits, and hyphens', t => {
  t.is(validateTeamSlug('team-leads-2024', '--team-leads-team'), 'team-leads-2024')
})

test('validateTeamSlug — throws for undefined', async t => {
  await t.exception.all(async () => validateTeamSlug(undefined, '--maintainers-team'))
})

test('validateTeamSlug — throws for empty string', async t => {
  await t.exception.all(async () => validateTeamSlug('', '--maintainers-team'))
})

test('validateTeamSlug — throws for slug with spaces', async t => {
  await t.exception.all(async () => validateTeamSlug('my team', '--maintainers-team'))
})

test('validateTeamSlug — throws for slug with slash', async t => {
  await t.exception.all(async () => validateTeamSlug('org/team', '--maintainers-team'))
})

test('validateTeamSlug — throws for slug with special characters', async t => {
  await t.exception.all(async () => validateTeamSlug('<script>', '--maintainers-team'))
})
