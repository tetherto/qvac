'use strict'

const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { gguf } = require('@huggingface/gguf')

const { fitBlobContent, writeFitBlob } = require('../../lib/fit-blob')
const {
  GGML_TYPE_F32,
  GGML_TYPE_F16,
  GGML_TYPE_Q8_0,
  DEFAULT_TOKENS,
  DEFAULT_WHISPER_TENSORS,
  DEFAULT_INDICTRANS_TENSORS,
  DEFAULT_MARIAN_ITEMS,
  buildWhisperBin,
  buildWhisperVadBin,
  buildBciEmbedder,
  buildSentencePiece,
  buildIndicTransBin,
  buildMarianModel,
  buildMarianShortlist
} = require('../helpers/bin-fixtures')

const WHISPER_ENGINE = '@qvac/transcription-whispercpp'
const BCI_ENGINE = '@qvac/bci-whispercpp'
const NMT_ENGINE = '@qvac/translation-nmtcpp'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-description-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFixture(dir, name, buffer) {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

async function describe(t, name, buffer, engine) {
  const dir = tempDir(t)
  const content = await fitBlobContent(writeFixture(dir, name, buffer), engine)
  const parsed = await gguf(writeFixture(dir, 'description.gguf', content), {
    allowLocalFile: true
  })
  return { content, metadata: parsed.metadata, tensors: parsed.tensorInfos }
}

function shapes(tensors) {
  return tensors.map((tensor) => ({
    name: tensor.name,
    type: tensor.dtype,
    ne: tensor.shape.map(Number)
  }))
}

function rejects(t, name, buffer, engine) {
  const dir = tempDir(t)
  return writeFitBlob(writeFixture(dir, name, buffer), dir, engine)
}

test('a whisper model is described by its header, vocabulary sizes and tensors', async (t) => {
  const artifact = buildWhisperBin()
  const { metadata, tensors } = await describe(t, 'ggml-tiny.bin', artifact, WHISPER_ENGINE)

  t.is(metadata['general.architecture'], 'whisper')
  t.is(metadata['fit_description.version'], 1)
  t.is(Number(metadata['fit_description.source_size']), artifact.length)
  t.is(metadata['whisper.n_vocab'], 51865)
  t.is(metadata['whisper.n_audio_layer'], 4)
  t.is(metadata['whisper.n_mels'], 80)
  t.is(metadata['whisper.ftype'], 1)
  t.absent(metadata['whisper.n_audio_conv1_kernel'], 'no BCI fields below the BCI mel count')
  t.is(metadata['whisper.mel_filters.n_mel'], 2)
  t.is(metadata['whisper.mel_filters.n_fft'], 3)
  t.is(metadata['whisper.vocab.n_tokens'], DEFAULT_TOKENS.length)
  t.alike(
    metadata['whisper.vocab.token_length_counts'],
    [1, 1, 1, 1, 2],
    'tokens counted by length'
  )
  t.alike(shapes(tensors), DEFAULT_WHISPER_TENSORS, 'every tensor in file order')
})

test('a description does not grow with the weights it describes', async (t) => {
  const small = buildWhisperBin({
    tensors: [{ name: 'decoder.token_embedding.weight', type: GGML_TYPE_F32, ne: [4, 4] }]
  })
  const large = buildWhisperBin({
    tensors: [{ name: 'decoder.token_embedding.weight', type: GGML_TYPE_F32, ne: [512, 512] }]
  })

  const smallDescription = await describe(t, 'ggml-small.bin', small, WHISPER_ENGINE)
  const largeDescription = await describe(t, 'ggml-large.bin', large, WHISPER_ENGINE)

  t.is(largeDescription.content.length, smallDescription.content.length)
  t.ok(largeDescription.content.length < large.length / 100)
})

test('a BCI whisper model keeps the three header fields its loader reads', async (t) => {
  const artifact = buildWhisperBin({
    nMels: 512,
    bci: [7, 57, 3],
    melFilters: { nMel: 512, nFft: 4 }
  })
  const { metadata } = await describe(t, 'ggml-bci-windowed.bin', artifact, BCI_ENGINE)

  t.is(metadata['whisper.n_mels'], 512)
  t.is(metadata['whisper.n_audio_conv1_kernel'], 7)
  t.is(metadata['whisper.n_audio_window_size'], 57)
  t.is(metadata['whisper.n_audio_last_window_layer'], 3)
  t.is(metadata['whisper.mel_filters.n_mel'], 512)
})

test('a whisper VAD model is described by its layout and tensors', async (t) => {
  const { metadata, tensors } = await describe(
    t,
    'ggml-silero-v5.1.2.bin',
    buildWhisperVadBin(),
    WHISPER_ENGINE
  )

  t.is(metadata['general.architecture'], 'whisper_vad')
  t.is(metadata['whisper_vad.model_type'], 'silero-16k')
  t.alike(metadata['whisper_vad.version'], [5, 1, 2])
  t.is(metadata['whisper_vad.n_window'], 512)
  t.is(metadata['whisper_vad.n_context'], 64)
  t.alike(metadata['whisper_vad.encoder_in_channels'], [129, 128])
  t.alike(metadata['whisper_vad.encoder_out_channels'], [128, 64])
  t.alike(metadata['whisper_vad.encoder_kernel_size'], [3, 3])
  t.is(metadata['whisper_vad.lstm_hidden_size'], 128)
  t.is(metadata['whisper_vad.final_conv_out'], 1)
  t.alike(shapes(tensors), DEFAULT_WHISPER_TENSORS)
})

test('a BCI embedder lists every weight array it holds', async (t) => {
  const { metadata, tensors } = await describe(
    t,
    'bci-embedder.bin',
    buildBciEmbedder({ numFeatures: 4, rank: 2, numDays: 2, numMonths: 1, sessions: 3 }),
    BCI_ENGINE
  )

  t.is(metadata['general.architecture'], 'bci_embedder')
  t.is(metadata['bci_embedder.num_features'], 4)
  t.is(metadata['bci_embedder.num_days'], 2)
  t.is(metadata['bci_embedder.num_months'], 1)
  t.is(metadata['bci_embedder.rank'], 2)
  t.alike(
    shapes(tensors).map(({ name, ne }) => `${name}:${ne}`),
    [
      'conv.0:6',
      'conv.1:8',
      'conv.2:5',
      'conv.3:8',
      'session_to_day:3',
      'day.0.a:8',
      'day.0.b:8',
      'day.0.bias:4',
      'day.1.a:8',
      'day.1.b:8',
      'day.1.bias:4',
      'month.0.weight:16',
      'month.0.bias:4'
    ]
  )
})

test('a SentencePiece model is described by its piece sizes and normalizer', async (t) => {
  const { metadata, tensors } = await describe(
    t,
    'vocab.enes.spm',
    buildSentencePiece({ pieces: ['<unk>', 'a', 'bc', 'bc'], modelType: 2, charsmapBytes: 24 }),
    NMT_ENGINE
  )

  t.is(metadata['general.architecture'], 'sentencepiece')
  t.is(metadata['sentencepiece.model_type'], 2)
  t.is(metadata['sentencepiece.n_pieces'], 4)
  t.alike(metadata['sentencepiece.piece_length_counts'], [0, 1, 2, 0, 0, 1])
  t.is(Number(metadata['sentencepiece.precompiled_charsmap_bytes']), 24)
  t.is(Number(metadata['sentencepiece.denormalizer_charsmap_bytes']), 0)
  t.is(tensors.length, 0)
})

test('an IndicTrans model is described with both vocabularies and embedded tokenizers', async (t) => {
  const { metadata, tensors } = await describe(
    t,
    'ggml-indictrans2-en-indic-dist-200M-q4_0.bin',
    buildIndicTransBin(),
    NMT_ENGINE
  )

  t.is(metadata['general.architecture'], 'nmt')
  t.is(metadata['nmt.model_type'], 1)
  t.is(metadata['nmt.n_vocab'], 6)
  t.is(metadata['nmt.n_tgt_vocab'], 4)
  t.is(metadata['nmt.decoder_ffn_dim'], 16)
  t.is(metadata['nmt.src_vocab.n_tokens'], DEFAULT_TOKENS.length)
  t.is(metadata['nmt.tgt_vocab.n_tokens'], 2)
  t.alike(metadata['nmt.tgt_vocab.token_length_counts'], [0, 1, 1])
  t.ok(Number(metadata['nmt.src_spm.bytes']) > 0)
  t.is(metadata['nmt.src_spm.n_pieces'], 6)
  t.is(metadata['nmt.tgt_spm.n_pieces'], 2)
  t.alike(shapes(tensors), DEFAULT_INDICTRANS_TENSORS)
})

test('an IndicTrans model without embedded tokenizers records them as absent', async (t) => {
  const { metadata } = await describe(
    t,
    'ggml-indictrans2.bin',
    buildIndicTransBin({ sourceSentencePiece: null, targetSentencePiece: null }),
    NMT_ENGINE
  )

  t.is(Number(metadata['nmt.src_spm.bytes']), 0)
  t.absent(metadata['nmt.src_spm.n_pieces'])
})

test('a Marian model is described by its config and item inventory', async (t) => {
  const artifact = buildMarianModel()
  const { metadata, tensors } = await describe(
    t,
    'model.enes.intgemm.alphas.bin',
    artifact,
    NMT_ENGINE
  )

  t.is(metadata['general.architecture'], 'marian')
  t.is(metadata['marian.config'], 'dim-emb: 4\nenc-depth: 1\n')
  t.alike(metadata['marian.items.names'], [
    ...DEFAULT_MARIAN_ITEMS.map((item) => item.name),
    'special:model.yml'
  ])
  t.alike(metadata['marian.items.types'], [0x4101, 0x404, 0x101])
  t.alike(metadata['marian.items.shape_ranks'], [2, 2, 1])
  t.alike(metadata['marian.items.shapes'], [8, 4, 1, 8, 1])
  t.alike(metadata['marian.items.data_bytes'].map(Number), [36, 32, 25])
  t.is(tensors.length, 0)
})

test('a Marian shortlist is described by its table sizes', async (t) => {
  const { metadata } = await describe(
    t,
    'lex.50.50.enes.s2t.bin',
    buildMarianShortlist({
      firstNum: 50,
      bestNum: 25,
      wordToOffset: [0, 2, 3],
      shortLists: [1, 2, 0]
    }),
    NMT_ENGINE
  )

  t.is(metadata['general.architecture'], 'marian_shortlist')
  t.is(Number(metadata['marian_shortlist.first_num']), 50)
  t.is(Number(metadata['marian_shortlist.best_num']), 25)
  t.is(Number(metadata['marian_shortlist.word_to_offset_size']), 3)
  t.is(Number(metadata['marian_shortlist.short_lists_size']), 3)
})

test('a description is the same bytes on every run', async (t) => {
  const artifact = buildWhisperBin()
  const first = await describe(t, 'ggml-tiny.bin', artifact, WHISPER_ENGINE)
  const second = await describe(t, 'ggml-tiny.bin', artifact, WHISPER_ENGINE)

  t.alike(first.content, second.content)
})

test('a truncated whisper model yields no description', async (t) => {
  const artifact = buildWhisperBin()
  t.is(
    await rejects(t, 'ggml-tiny.bin', artifact.subarray(0, artifact.length - 3), WHISPER_ENGINE),
    null
  )
})

test('bytes after the last whisper tensor yield no description', async (t) => {
  const artifact = Buffer.concat([buildWhisperBin(), Buffer.alloc(5)])
  t.is(await rejects(t, 'ggml-tiny.bin', artifact, WHISPER_ENGINE), null)
})

test('a tensor of an unknown type yields no description', async (t) => {
  const artifact = buildWhisperBin({
    tensors: [{ name: 'encoder.conv1.bias', type: GGML_TYPE_F32, ne: [4] }]
  })
  const typeOffset = artifact.length - 4 * 4 - Buffer.byteLength('encoder.conv1.bias') - 4 * 2
  artifact.writeInt32LE(4, typeOffset)
  t.is(await rejects(t, 'ggml-tiny.bin', artifact, WHISPER_ENGINE), null)
})

test('a model is only read with the readers of its own engine', async (t) => {
  t.is(
    await rejects(t, 'ggml-tiny.bin', buildWhisperBin(), NMT_ENGINE),
    null,
    'not an nmt.cpp file'
  )
  t.is(
    await rejects(t, 'model.bin', buildMarianModel(), WHISPER_ENGINE),
    null,
    'not a whisper file'
  )
  t.is(await rejects(t, 'vocab.spm', buildSentencePiece(), WHISPER_ENGINE), null, 'no spm reader')
})

test('an nmt.cpp model of a retired type yields no description', async (t) => {
  t.is(
    await rejects(t, 'ggml-opus-en-de.bin', buildIndicTransBin({ modelType: 0 }), NMT_ENGINE),
    null
  )
})

test('a shortlist whose tables disagree with its size yields no description', async (t) => {
  const artifact = Buffer.concat([buildMarianShortlist(), Buffer.alloc(4)])
  t.is(await rejects(t, 'lex.50.50.enes.s2t.bin', artifact, NMT_ENGINE), null)
})

test('a SentencePiece file that is not a model proto yields no description', async (t) => {
  t.is(await rejects(t, 'vocab.enes.spm', Buffer.from([0x0a, 0x7f, 0x01]), NMT_ENGINE), null)
})

test('an embedder with bytes past its last array yields no description', async (t) => {
  const artifact = Buffer.concat([buildBciEmbedder(), Buffer.alloc(4)])
  t.is(await rejects(t, 'bci-embedder.bin', artifact, BCI_ENGINE), null)
})

test('quantized rows that are not whole blocks yield no description', async (t) => {
  const artifact = buildWhisperBin({
    tensors: [{ name: 'decoder.token_embedding.weight', type: GGML_TYPE_Q8_0, ne: [32, 2] }]
  })
  const firstDimOffset =
    artifact.length - 2 * 34 - Buffer.byteLength('decoder.token_embedding.weight') - 4 * 2
  artifact.writeInt32LE(16, firstDimOffset)
  t.is(await rejects(t, 'ggml-tiny.bin', artifact, WHISPER_ENGINE), null)
})

test('f16 tensors keep their type', async (t) => {
  const { tensors } = await describe(
    t,
    'ggml-tiny.bin',
    buildWhisperBin({
      tensors: [{ name: 'encoder.conv1.weight', type: GGML_TYPE_F16, ne: [3, 2, 4] }]
    }),
    WHISPER_ENGINE
  )
  t.is(tensors[0].dtype, GGML_TYPE_F16)
})
