import {
  createVectorIndex,
  embed,
  loadModel,
  loadVectorIndex,
  unloadModel,
  GTE_LARGE_FP16,
  VectorIndexStorage
} from '@qvac/sdk'

// Retrieval over documents kept in your own store. The SDK holds only the
// vectors, in a TurboVec index inside the worker; the documents stay in this
// Map (or any database you choose) and result ids map back to them.
try {
  const query = process.argv[2] || 'Which moon has methane rain and lakes?'
  console.log(`▸ Query: "${query}"`)

  const documents = new Map<string, string>([
    ['1', 'Saturn moon Titan has lakes, clouds, and rain made of liquid methane.'],
    ['2', 'Solar panels convert sunlight into electricity using photovoltaic cells.'],
    ['3', 'Honeybees communicate the location of flowers through a waggle dance.'],
    ['4', 'The Pacific Ocean is the largest and deepest ocean on Earth.']
  ])

  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log('▸ Embedding documents...')
  const { embedding: vectors } = await embed({ modelId, text: [...documents.values()] })

  console.log('▸ Building the vector index...')
  const index = await createVectorIndex({
    dim: vectors[0]!.length,
    storage: VectorIndexStorage.TURBOVEC_Q4
  })
  await index.add({ ids: [...documents.keys()], vectors })
  console.log(`▸ Indexed ${index.length} vectors of dimension ${index.dim}`)

  console.log('▸ Searching...')
  const { embedding: queryVector } = await embed({ modelId, text: query })
  const hits = await index.search({ query: queryVector, k: 2 })
  console.log('▸ Top matches:')
  for (const hit of hits) {
    console.log(`  score=${hit.score.toFixed(4)} id=${hit.id}: ${documents.get(hit.id)}`)
  }

  // Snapshots persist the vectors only. A relative path resolves under the
  // QVAC data directory; pass an absolute path to store it elsewhere.
  const snapshotPath = 'examples/rag-turbovec.qvi'
  const { path: writtenPath } = await index.write({ path: snapshotPath })
  await index.dispose()
  console.log(`▸ Snapshot written to ${writtenPath}`)

  const reloaded = await loadVectorIndex({ path: snapshotPath })
  const [reloadedBest] = await reloaded.search({ query: queryVector, k: 1 })
  await reloaded.dispose()
  if (!reloadedBest || reloadedBest.id !== hits[0]?.id) {
    throw new Error(
      `Reloaded index returned id=${reloadedBest?.id} but the original returned id=${hits[0]?.id}`
    )
  }
  console.log(`▸ Reloaded index agrees: best match id=${reloadedBest.id}`)

  await unloadModel({ modelId })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
