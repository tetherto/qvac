'use strict'

const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { gguf } = require('@huggingface/gguf')

const { supportsFitBlob, fitBlobContent, writeFitBlob } = require('../../lib/fit-blob')
const { buildGguf, buildSafetensors, u64 } = require('../helpers/gguf-fixture')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-blob-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFixture(dir, name, buffer) {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

function parseBlob(dir, buffer) {
  return gguf(writeFixture(dir, 'blob.gguf', buffer), { allowLocalFile: true })
}

// lunte-disable-next-line require-await
test('supportsFitBlob accepts only the formats with a separable description', async (t) => {
  t.ok(supportsFitBlob('/models/model.gguf'))
  t.ok(supportsFitBlob('/models/MODEL.GGUF'))
  t.ok(supportsFitBlob('/models/model.safetensors'))
  t.absent(supportsFitBlob('/models/ggml-small.en-q8_0.bin'))
  t.absent(supportsFitBlob('/models/upscaler.pth'))
  t.absent(supportsFitBlob('/models/tokenizer.spm'))
})

test('a GGUF fit blob drops the tokenizer tables and keeps the tensors', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf({ tensorCount: 3, dataBytes: 4096, vocabSize: 64 })
  const filePath = writeFixture(dir, 'model.gguf', fixture.buffer)

  const content = await fitBlobContent(filePath)
  const parsed = await parseBlob(dir, content)

  t.alike(
    parsed.tensorInfos.map((info) => info.name),
    fixture.tensorNames,
    'every tensor is described'
  )
  t.is(parsed.metadata['tokenizer.ggml.model'], 'none', 'the vocabulary is declared absent')
  t.absent(parsed.metadata['tokenizer.ggml.tokens'], 'no token table')
  t.absent(parsed.metadata['tokenizer.ggml.scores'], 'no score table')
  t.absent(parsed.metadata['tokenizer.ggml.merges'], 'no merge table')
  t.is(parsed.metadata['general.architecture'], 'llama', 'settings survive')
  t.ok(content.length < fixture.metadataLength, 'smaller than the artifact description')
})

test('a tokenizer under the architecture prefix is dropped too', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf({
    tensorCount: 3,
    dataBytes: 4096,
    vocabSize: 64,
    architecture: 'parler',
    architectureTokenizer: true
  })
  const filePath = writeFixture(dir, 'model.gguf', fixture.buffer)

  const content = await fitBlobContent(filePath)
  const parsed = await parseBlob(dir, content)

  t.absent(parsed.metadata['parler.prompt_tokenizer.tokens'], 'no prefixed token table')
  t.absent(parsed.metadata['parler.prompt_tokenizer.merges'], 'no prefixed merge table')
  t.alike(
    parsed.tensorInfos.map((info) => info.name),
    fixture.tensorNames,
    'every tensor is described'
  )
  t.is(parsed.metadata['parler.embedding_length'], fixture.embeddingLength, 'settings survive')
})

test('a per-tensor manifest is dropped', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf({
    tensorCount: 3,
    dataBytes: 4096,
    architecture: 'supertonic',
    tensorManifest: true
  })
  const filePath = writeFixture(dir, 'model.gguf', fixture.buffer)

  const parsed = await parseBlob(dir, await fitBlobContent(filePath))

  t.absent(parsed.metadata['supertonic.tensor_names'], 'no name manifest')
  t.absent(parsed.metadata['supertonic.tensor_sha256'], 'no checksum manifest')
  t.alike(
    parsed.tensorInfos.map((info) => info.name),
    fixture.tensorNames,
    'the tensor list still carries every name'
  )
})

test('the vocabulary size comes from the token embedding when undeclared', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf({ vocabSize: 151936, embeddingLength: 2048, architecture: 'qwen3' })
  const filePath = writeFixture(dir, 'model.gguf', fixture.buffer)

  const parsed = await parseBlob(dir, await fitBlobContent(filePath))

  t.is(parsed.metadata['qwen3.vocab_size'], 151936, 'the token count, not the embedding width')
})

test('a declared vocabulary size is carried through', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf({ vocabSize: 128256, embeddingLength: 2048, declareVocabSize: true })
  const filePath = writeFixture(dir, 'model.gguf', fixture.buffer)

  const parsed = await parseBlob(dir, await fitBlobContent(filePath))

  t.is(parsed.metadata['llama.vocab_size'], 128256)
})

test('a file with no architecture gets no vocabulary size', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf({ architecture: null, vocabSize: 512 })
  const filePath = writeFixture(dir, 'headless.gguf', fixture.buffer)

  const parsed = await parseBlob(dir, await fitBlobContent(filePath))

  t.absent(
    Object.keys(parsed.metadata).find((key) => key.endsWith('vocab_size')),
    'no vocabulary size is written without an architecture to name it after'
  )
})

test('a BERT token type count survives', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf({ architecture: 'bert', vocabSize: 30522, tokenTypeCount: 2 })
  const filePath = writeFixture(dir, 'model.gguf', fixture.buffer)

  const parsed = await parseBlob(dir, await fitBlobContent(filePath))

  t.is(parsed.metadata['tokenizer.ggml.token_type_count'], 2)
  t.is(parsed.metadata['tokenizer.ggml.model'], 'none')
})

test('a safetensors fit blob is its JSON header', async (t) => {
  const dir = tempDir(t)
  const fixture = buildSafetensors()
  const filePath = writeFixture(dir, 'vae.safetensors', fixture.buffer)

  const content = await fitBlobContent(filePath)

  t.is(content.length, fixture.metadataLength)
  t.alike(content, fixture.buffer.subarray(0, fixture.metadataLength))
})

test('the recorded checksum covers the blob, not the artifact', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf()
  const filePath = writeFixture(dir, 'model.gguf', fixture.buffer)

  const blob = await writeFitBlob(filePath, dir)
  const expected = crypto.createHash('sha256').update(fs.readFileSync(blob.path)).digest('hex')

  t.is(blob.sha256, expected)
  t.not(blob.sha256, crypto.createHash('sha256').update(fixture.buffer).digest('hex'))
})

test('an unsupported format yields no blob', async (t) => {
  const dir = tempDir(t)
  const filePath = writeFixture(dir, 'ggml-tiny.bin', Buffer.alloc(256, 3))

  t.is(await writeFitBlob(filePath, dir), null)
})

test('a truncated GGUF yields no blob instead of throwing', async (t) => {
  const dir = tempDir(t)
  const fixture = buildGguf()
  const filePath = writeFixture(dir, 'model.gguf', fixture.buffer.subarray(0, 12))

  t.is(await writeFitBlob(filePath, dir), null)
})

test('a safetensors with an implausible header length yields no blob', async (t) => {
  const dir = tempDir(t)
  const filePath = writeFixture(
    dir,
    'broken.safetensors',
    Buffer.concat([u64(2 ** 40), Buffer.alloc(16)])
  )

  t.is(await writeFitBlob(filePath, dir), null)
})

test('a missing file yields no blob', async (t) => {
  const dir = tempDir(t)

  t.is(await writeFitBlob(path.join(dir, 'absent.gguf'), dir), null)
})
