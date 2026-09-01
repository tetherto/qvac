import test from 'brittle'
import {
  extractHubSha256,
  isHuggingFaceHost,
  isLoopbackHost,
  isSecureDownloadUrl
} from '@/utils/url-security'

const SHA256 = 'fa0390e7c043f89ae1847bd6682d748041a99d4ef3de0e0b27d33b6af97a8be8'

test('isLoopbackHost: recognizes loopback addresses', (t) => {
  t.ok(isLoopbackHost('localhost'))
  t.ok(isLoopbackHost('127.0.0.1'))
  t.ok(isLoopbackHost('127.1.2.3'))
  t.ok(isLoopbackHost('::1'))
  t.ok(isLoopbackHost('[::1]'))
  t.ok(isLoopbackHost('LOCALHOST'))
  t.absent(isLoopbackHost('example.com'))
  t.absent(isLoopbackHost('10.0.0.1'))
  t.absent(isLoopbackHost('0.0.0.0'))
  t.absent(isLoopbackHost('huggingface.co'))
  // 127.* must be an IPv4 address, not a string prefix of a registrable domain.
  t.absent(isLoopbackHost('127.0.0.1.evil.com'))
  t.absent(isLoopbackHost('127.example.com'))
  t.absent(isLoopbackHost('127.0.0.256'))
})

test('isHuggingFaceHost: matches the Hub hosts only', (t) => {
  t.ok(isHuggingFaceHost('huggingface.co'))
  t.ok(isHuggingFaceHost('hf.co'))
  t.ok(isHuggingFaceHost('HuggingFace.co'))
  t.absent(isHuggingFaceHost('us.aws.cdn.hf.co'))
  t.absent(isHuggingFaceHost('evil-huggingface.co'))
  t.absent(isHuggingFaceHost('huggingface.co.evil.com'))
})

test('isSecureDownloadUrl: https always, http only for loopback', (t) => {
  t.ok(isSecureDownloadUrl('https://huggingface.co/x'))
  t.ok(isSecureDownloadUrl('https://example.com/model.gguf'))
  t.ok(isSecureDownloadUrl('http://localhost:8080/model.gguf'))
  t.ok(isSecureDownloadUrl('http://127.0.0.1:3000/model.gguf'))
  t.absent(isSecureDownloadUrl('http://example.com/model.gguf'))
  t.absent(isSecureDownloadUrl('http://10.0.0.5/model.gguf'))
  t.absent(isSecureDownloadUrl('ftp://example.com/model.gguf'))
  t.absent(isSecureDownloadUrl('not a url'))
})

test('extractHubSha256: reads a SHA-256-shaped X-Linked-Etag', (t) => {
  t.is(extractHubSha256({ 'x-linked-etag': `"${SHA256}"` }), SHA256)
  t.is(extractHubSha256({ 'x-linked-etag': SHA256 }), SHA256)
  t.is(extractHubSha256({ 'x-linked-etag': `W/"${SHA256}"` }), SHA256)
  // Prefers x-linked-etag over etag.
  t.is(extractHubSha256({ 'x-linked-etag': `"${SHA256}"`, etag: '"other"' }), SHA256)
  // Falls back to etag.
  t.is(extractHubSha256({ etag: `"${SHA256}"` }), SHA256)
  // Uppercase is normalized to lowercase.
  t.is(extractHubSha256({ 'x-linked-etag': `"${SHA256.toUpperCase()}"` }), SHA256)
})

test('extractHubSha256: rejects non-SHA-256 etags', (t) => {
  // A git blob SHA-1 (40 hex) is not the content SHA-256.
  t.is(extractHubSha256({ etag: '"5f2f1c0a9b8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c"' }), undefined)
  // A CDN multipart etag.
  t.is(extractHubSha256({ etag: '"abc123-2"' }), undefined)
  t.is(extractHubSha256({}), undefined)
  t.is(extractHubSha256({ 'x-linked-etag': '""' }), undefined)
})
