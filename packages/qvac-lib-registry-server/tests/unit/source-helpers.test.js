'use strict'

const test = require('brittle')
const { parseCanonicalSource, resolveS3Bucket } = require('../../lib/source-helpers')

test('parseCanonicalSource - S3 URL with bucket', async (t) => {
  const result = parseCanonicalSource('s3://my-bucket/path/to/model.gguf')

  t.is(result.protocol, 's3')
  t.is(result.bucket, 'my-bucket')
  t.is(result.key, 'path/to/model.gguf')
  t.is(result.path, 'path/to/model.gguf', 'path should NOT include bucket name')
  t.is(result.filename, 'model.gguf')
  t.is(result.canonicalUrl, 's3://my-bucket/path/to/model.gguf')
})

test('parseCanonicalSource - S3 URL without bucket', async (t) => {
  const result = parseCanonicalSource('s3:///qvac_models_compiled/ggml/Llama-3.2-1B/2025-12-04/model.gguf')

  t.is(result.protocol, 's3')
  t.is(result.bucket, null, 'bucket should be null when omitted')
  t.is(result.key, 'qvac_models_compiled/ggml/Llama-3.2-1B/2025-12-04/model.gguf')
  t.is(result.path, 'qvac_models_compiled/ggml/Llama-3.2-1B/2025-12-04/model.gguf')
  t.is(result.filename, 'model.gguf')
  t.is(result.canonicalUrl, 's3:///qvac_models_compiled/ggml/Llama-3.2-1B/2025-12-04/model.gguf')
})

test('parseCanonicalSource - S3 URL with leading slash in path', async (t) => {
  const result = parseCanonicalSource('s3://bucket-name//some/path/file.bin')

  t.is(result.protocol, 's3')
  t.is(result.bucket, 'bucket-name')
  t.is(result.key, 'some/path/file.bin', 'leading slashes should be normalized')
  t.is(result.path, 'some/path/file.bin')
})

test('resolveS3Bucket - injects bucket when missing', async (t) => {
  const source = parseCanonicalSource('s3:///path/to/model.gguf')
  t.is(source.bucket, null)

  const resolved = resolveS3Bucket(source, 'my-bucket')
  t.is(resolved.bucket, 'my-bucket')
  t.is(resolved.key, 'path/to/model.gguf')
  t.is(resolved.canonicalUrl, 's3://my-bucket/path/to/model.gguf')
})

test('resolveS3Bucket - preserves existing bucket', async (t) => {
  const source = parseCanonicalSource('s3://existing-bucket/path/to/model.gguf')
  const resolved = resolveS3Bucket(source, 'other-bucket')

  t.is(resolved.bucket, 'existing-bucket', 'should not override existing bucket')
  t.is(resolved.canonicalUrl, 's3://existing-bucket/path/to/model.gguf')
})

test('resolveS3Bucket - throws when bucket missing and none provided', async (t) => {
  const source = parseCanonicalSource('s3:///path/to/model.gguf')

  try {
    resolveS3Bucket(source, null)
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('QVAC_S3_BUCKET'), 'error references env var')
  }
})

test('resolveS3Bucket - no-op for non-S3 sources', async (t) => {
  const source = parseCanonicalSource('https://huggingface.co/org/repo/resolve/main/model.gguf')
  const resolved = resolveS3Bucket(source, 'some-bucket')

  t.is(resolved.protocol, 'hf')
  t.is(resolved.bucket, undefined, 'HF source should not get a bucket')
})

test('parseCanonicalSource - HuggingFace URL', async (t) => {
  const result = parseCanonicalSource('https://huggingface.co/org/repo/resolve/main/model.gguf')

  t.is(result.protocol, 'hf')
  t.is(result.path, 'org/repo/resolve/main/model.gguf')
  t.is(result.filename, 'model.gguf')
  t.is(result.bucket, undefined)
  t.is(result.key, undefined)
})

test('parseCanonicalSource - throws on unsupported URL', async (t) => {
  try {
    parseCanonicalSource('https://example.com/file.bin')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Unsupported source URL'), 'throws on unsupported https URL')
  }

  try {
    parseCanonicalSource('ftp://server/file.bin')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Unsupported source URL'), 'throws on ftp URL')
  }
})

test('parseCanonicalSource - throws on empty/invalid input', async (t) => {
  try {
    parseCanonicalSource('')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('must be a non-empty string'), 'throws on empty string')
  }

  try {
    parseCanonicalSource('   ')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('must be a non-empty string'), 'throws on whitespace')
  }

  try {
    parseCanonicalSource(null)
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('must be a non-empty string'), 'throws on null')
  }

  try {
    parseCanonicalSource(123)
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('must be a non-empty string'), 'throws on number')
  }
})
