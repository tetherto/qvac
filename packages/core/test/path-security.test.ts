import test from 'brittle'
import { resolve, sep, join } from 'bare-path'
import fs from 'bare-fs'
import os from 'bare-os'
import { sanitizePathComponent, checkPathWithinBase } from '../src/utils/path-sanitize'
import { validateAndJoinPath, isPathWithinBase } from '../src/engine/utils/path-security'
import { extractTarStream } from '../src/engine/utils/archive'

// ============== sanitizePathComponent ==============

test('sanitizePathComponent: strips ../ sequences', function (t) {
  t.is(sanitizePathComponent('../../../etc/passwd'), 'etc/passwd')
  t.is(sanitizePathComponent('foo/../../../bar'), 'foo/bar')
})

test('sanitizePathComponent: strips ..\\ sequences', function (t) {
  t.is(sanitizePathComponent('..\\..\\..\\Windows\\System32'), 'Windows/System32')
})

test('sanitizePathComponent: strips leading absolute path prefixes', function (t) {
  t.is(sanitizePathComponent('/etc/passwd'), 'etc/passwd')
  t.is(sanitizePathComponent('C:\\Windows\\System32'), 'Windows/System32')
  t.is(sanitizePathComponent('D:\\data\\file.txt'), 'data/file.txt')
})

test('sanitizePathComponent: rejects null bytes', function (t) {
  t.exception(() => sanitizePathComponent('foo\0bar'), 'should throw on null byte')
  t.exception(() => sanitizePathComponent('foo%00bar'), 'should throw on URL-encoded null byte')
})

test('sanitizePathComponent: handles mixed separator attacks', function (t) {
  const result = sanitizePathComponent('..\\../mixed')
  t.ok(!result.includes('..'), `result "${result}" should not contain ..`)
})

test('sanitizePathComponent: handles URL-encoded traversal', function (t) {
  const result = sanitizePathComponent('%2e%2e%2f%2e%2e%2f')
  t.ok(!result.includes('..'), `result "${result}" should not contain ..`)
})

test('sanitizePathComponent: passes through clean names unchanged', function (t) {
  t.is(sanitizePathComponent('model.gguf'), 'model.gguf')
  t.is(sanitizePathComponent('my-model-00001-of-00002.gguf'), 'my-model-00001-of-00002.gguf')
  t.is(sanitizePathComponent('workspace-name'), 'workspace-name')
  t.is(sanitizePathComponent('abc123_def456'), 'abc123_def456')
})

test('sanitizePathComponent: handles empty string', function (t) {
  t.is(sanitizePathComponent(''), '')
})

// ============== checkPathWithinBase ==============

test('checkPathWithinBase: returns true for contained paths', function (t) {
  t.ok(checkPathWithinBase('/safe/dir', '/safe/dir/file.txt', resolve, sep))
  t.ok(checkPathWithinBase('/safe/dir', '/safe/dir/sub/deep/file.txt', resolve, sep))
  t.ok(checkPathWithinBase('/safe/dir/', '/safe/dir/file.txt', resolve, sep))
})

test('checkPathWithinBase: returns false for escaped paths', function (t) {
  t.absent(checkPathWithinBase('/safe/dir', '/safe/dir/../../../etc/passwd', resolve, sep))
  t.absent(checkPathWithinBase('/safe/dir', '/etc/passwd', resolve, sep))
  t.absent(checkPathWithinBase('/safe/dir', '/safe/di', resolve, sep))
  t.absent(checkPathWithinBase('/safe/dir', '/safe/directory/file.txt', resolve, sep))
})

test('checkPathWithinBase: handles the base path itself', function (t) {
  t.ok(checkPathWithinBase('/safe/dir', '/safe/dir', resolve, sep))
  t.ok(checkPathWithinBase('/safe/dir', '/safe/dir/', resolve, sep))
})

// ============== validateAndJoinPath / isPathWithinBase ==============

test('validateAndJoinPath: joins clean components', function (t) {
  const result = validateAndJoinPath('/base/dir', 'subdir', 'file.gguf')
  t.ok(result.endsWith('/base/dir/subdir/file.gguf'), `result: ${result}`)
})

test('validateAndJoinPath: neutralizes traversal', function (t) {
  const result = validateAndJoinPath('/base/dir', '../../../etc/passwd')
  t.ok(isPathWithinBase('/base/dir', result), `result "${result}" must be within /base/dir`)
})

test('validateAndJoinPath: throws on null byte', function (t) {
  t.exception(() => validateAndJoinPath('/base/dir', 'foo\0bar.gguf'))
})

test('isPathWithinBase: rejects escaped paths', function (t) {
  t.absent(isPathWithinBase('/safe/dir', '/etc/passwd'))
  t.absent(isPathWithinBase('/safe/dir', '/safe/dir/../../../etc/passwd'))
  t.absent(isPathWithinBase('/safe/dir', '/safe/directory/file.txt'))
})

test('isPathWithinBase: accepts contained paths', function (t) {
  t.ok(isPathWithinBase('/safe/dir', '/safe/dir/file.txt'))
  t.ok(isPathWithinBase('/safe/dir', '/safe/dir'))
})

// ============== archive extraction (zip-slip) ==============

test('extractTarStream: malicious entries do not escape extractDir', async function (t) {
  const cwd = os.cwd()
  const fixturePath = join(cwd, 'test', 'fixtures', 'malicious-zipslip.tar.gz')
  const extractDir = join(cwd, 'test', 'fixtures', 'tmp-extract-bare')

  const escapedPaths = [
    resolve(join(extractDir, '../../../escape.gguf')),
    resolve(join(extractDir, '../../../../tmp/pwned.gguf')),
    resolve(join(extractDir, 'models/../../../../../../escape-nested.gguf'))
  ]

  fs.mkdirSync(extractDir, { recursive: true })

  try {
    await extractTarStream(fixturePath, extractDir, true)

    for (const p of escapedPaths) {
      let exists = false
      try {
        fs.accessSync(p)
        exists = true
      } catch {}
      t.absent(exists, `file must not exist outside extractDir: ${p}`)
    }

    const files = fs.readdirSync(extractDir) as string[]
    const legit = files.filter((f) => f.startsWith('legit-model-'))
    t.is(legit.length, 2, 'legitimate shard files must be extracted')
  } finally {
    try {
      fs.rmSync(extractDir, { recursive: true })
    } catch {}
    for (const p of escapedPaths) {
      try {
        fs.rmSync(p)
      } catch {}
    }
  }
})
