const { RAG, HyperDBAdapter } = require('../index')
const Corestore = require('corestore')
const EmbedderPlugin = require('@qvac/embed-llamacpp')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const QvacLogger = require('@qvac/logging')

const gteDriveKey = 'd1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e'

const store = new Corestore('./local-store')
const modelDir = './models'

async function main () {
  // Load the embedder using HyperDriveDL
  const gteHdDL = new HyperDriveDL({
    key: `hd://${gteDriveKey}`,
    store
  })

  const embedderArgs = {
    loader: gteHdDL,
    opts: { stats: true },
    logger: console,
    diskPath: modelDir,
    modelName: 'gte-large_fp16.gguf'
  }
  const embedder = new EmbedderPlugin(embedderArgs, '-ngl\t99\n-dev\tgpu\n--embd-separator\t⟪§§§EMBED_SEP§§§⟫\n-c\t4096')
  await embedder.load(false)

  const embeddingFunction = async (text) => {
    const response = await embedder.run(text)
    const embeddings = await response.await()
    return Array.from(embeddings[0][0])
  }

  const dbAdapter = new HyperDBAdapter({ store })

  // Create logger for visibility
  const logger = new QvacLogger(console)

  // Sample text for chunking demonstrations
  const sampleText = 'Artificial intelligence is transforming industries. Machine learning algorithms process vast amounts of data efficiently. Deep learning uses neural networks with multiple layers. Natural language processing enables computers to understand human text.'

  console.log('Original text:')
  console.log(`"${sampleText}"`)
  console.log(`\nLength: ${sampleText.length} characters, ${sampleText.split(' ').length} words\n`)

  // 1. Default word-based chunking
  console.log('=== 1. Word Splitting (default) ===')
  const rag = new RAG({ embeddingFunction, dbAdapter, logger })

  const wordResult = await rag.chunk(sampleText, {
    splitStrategy: 'word',
    chunkSize: 15,
    chunkOverlap: 3
  })
  console.log('Chunking Options: splitStrategy: \'word\', chunkSize: 15, chunkOverlap: 3')
  console.log(`Created ${wordResult.length} chunks:`)
  wordResult.forEach((chunk, i) => {
    console.log(`  Chunk ${i + 1}: "${chunk.content}"`)
    console.log(`  Word Count: ${chunk.content.split(' ').filter(w => w).length}`)
  })

  // 2. Character-based splitting
  console.log('\n=== 2. Character Splitting ===')
  const charResult = await rag.chunk(sampleText, {
    splitStrategy: 'character',
    chunkSize: 50,
    chunkOverlap: 10
  })
  console.log('Chunking Options: splitStrategy: \'character\', chunkSize: 50, chunkOverlap: 10')
  console.log(`Created ${charResult.length} chunks:`)
  charResult.forEach((chunk, i) => {
    console.log(`  Chunk ${i + 1}: "${chunk.content}"`)
    console.log(`  Character Count: ${chunk.content.length}`)
  })

  // 3. Sentence-based splitting
  console.log('\n=== 3. Sentence Splitting ===')
  const sentenceResult = await rag.chunk(sampleText, {
    splitStrategy: 'sentence',
    chunkSize: 2,
    chunkOverlap: 1
  })
  console.log('Chunking Options: splitStrategy: \'sentence\', chunkSize: 2, chunkOverlap: 1')
  console.log(`Created ${sentenceResult.length} chunks:`)
  sentenceResult.forEach((chunk, i) => {
    console.log(`  Chunk ${i + 1}: "${chunk.content.trim()}"`)
  })

  // 4. Line-based splitting
  console.log('\n=== 4. Line Splitting ===')
  const multilineText = 'Line one: AI is transforming\nLine two: Machine learning processes data\nLine three: Deep learning uses networks\nLine four: NLP enables understanding'
  const lineResult = await rag.chunk(multilineText, {
    splitStrategy: 'line',
    chunkSize: 2,
    chunkOverlap: 1
  })
  console.log('Chunking Options: splitStrategy: \'line\', chunkSize: 2, chunkOverlap: 1')
  console.log(`Created ${lineResult.length} chunks:`)
  lineResult.forEach((chunk, i) => {
    console.log(`  Chunk ${i + 1}: "${chunk.content}"`)
  })

  // 5. Custom delimiter-based splitter
  console.log('\n=== 5. Custom Delimiter Splitter ===')
  const delimiterText = 'AI|Machine Learning|Deep Learning|NLP|Computer Vision|Robotics'
  const customDelimiterSplitter = (text) => text.split('|')

  const delimiterResult = await rag.chunk(delimiterText, {
    splitter: customDelimiterSplitter,
    chunkSize: 2,
    chunkOverlap: 1
  })
  console.log('Chunking Options: splitter: custom (split by |), chunkSize: 2, chunkOverlap: 1')
  console.log(`Created ${delimiterResult.length} chunks:`)
  delimiterResult.forEach((chunk, i) => {
    console.log(`  Chunk ${i + 1}: "${chunk.content}"`)
  })

  // 6. Custom whitespace-aware splitter
  console.log('\n=== 6. Custom Whitespace-Aware Splitter ===')
  const whitespaceSplitter = (text) => {
    // Split by whitespace and filter empty strings
    // Note: Tokens must match the original text for llm-splitter to work
    return text.split(/\s+/).filter(word => word.length > 0)
  }

  const whitespaceResult = await rag.chunk(sampleText, {
    splitter: whitespaceSplitter,
    chunkSize: 10,
    chunkOverlap: 2
  })
  console.log('Chunking Options: splitter: custom (whitespace-aware word split), chunkSize: 10, chunkOverlap: 2')
  console.log(`Created ${whitespaceResult.length} chunks:`)
  whitespaceResult.forEach((chunk, i) => {
    console.log(`  Chunk ${i + 1}: "${chunk.content}"`)
  })

  // 7. Chunk strategy comparison
  console.log('\n=== 7. Chunk Strategy: paragraph vs character ===')
  const paragraphText = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.'

  const paragraphStrategy = await rag.chunk(paragraphText, {
    splitStrategy: 'word',
    chunkStrategy: 'paragraph',
    chunkSize: 5,
    chunkOverlap: 1
  })
  console.log('With chunkStrategy: \'paragraph\':')
  console.log(`Created ${paragraphStrategy.length} chunks:`)
  paragraphStrategy.forEach((chunk, i) => {
    console.log(`  Chunk ${i + 1}: "${chunk.content}"`)
  })

  const characterStrategy = await rag.chunk(paragraphText, {
    splitStrategy: 'word',
    chunkStrategy: 'character',
    chunkSize: 5,
    chunkOverlap: 1
  })
  console.log('\nWith chunkStrategy: \'character\':')
  console.log(`Created ${characterStrategy.length} chunks:`)
  characterStrategy.forEach((chunk, i) => {
    console.log(`  Chunk ${i + 1}: "${chunk.content}"`)
  })

  // Cleanup
  await gteHdDL.close()
  await rag.close()
  await store.close()
}

main().catch(console.error)
