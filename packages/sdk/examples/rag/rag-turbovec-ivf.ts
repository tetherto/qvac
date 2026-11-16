import {
  createVectorIndex,
  embed,
  embedBatch,
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  VectorIndexStorage
} from '@qvac/sdk'

// IVF search over documents kept in your own store. setIvf() groups the
// vectors into lists, and each search scans only the lists nearest the query.
// On a large F32 index that can be many times faster than a full scan, while
// on TurboVec storage it can be slower. This example uses F32 storage with 16
// documents, so it shows the API rather than the speedup.
try {
  const query = process.argv[2] || 'Which moon has methane rain and lakes?'
  console.log(`▸ Query: "${query}"`)

  const documents = new Map<string, string>([
    ['1', 'Saturn moon Titan has lakes, clouds, and rain made of liquid methane.'],
    ['2', 'Jupiter moon Europa hides a salty ocean under a shell of ice.'],
    ['3', 'Mars has the tallest volcano in the solar system, Olympus Mons.'],
    ['4', 'Venus is the hottest planet because its thick air traps heat.'],
    ['5', 'Solar panels convert sunlight into electricity using photovoltaic cells.'],
    ['6', 'Wind turbines turn the motion of air into electrical power.'],
    ['7', 'Lithium-ion batteries store energy for phones and electric cars.'],
    ['8', 'Hydroelectric dams generate power from water flowing downhill.'],
    ['9', 'Honeybees communicate the location of flowers through a waggle dance.'],
    ['10', 'Octopuses can change the color and texture of their skin in an instant.'],
    ['11', 'Arctic terns migrate from pole to pole every year.'],
    ['12', 'Elephants recognize themselves in a mirror.'],
    ['13', 'The Pacific Ocean is the largest and deepest ocean on Earth.'],
    ['14', 'Coral reefs grow from colonies of tiny animals called polyps.'],
    ['15', 'Ocean tides rise and fall with the pull of the Moon.'],
    ['16', 'The Mariana Trench reaches nearly eleven kilometers below sea level.']
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
  const { embedding: vectors } = await embedBatch({ modelId, inputs: [...documents.values()] })

  console.log('▸ Building the vector index...')
  const index = await createVectorIndex({
    dim: vectors[0]!.length,
    storage: VectorIndexStorage.F32
  })
  await index.add({ ids: [...documents.keys()], vectors })
  console.log(`▸ Indexed ${index.length} vectors of dimension ${index.dim}`)

  const { embedding: queryVector } = await embed({ modelId, text: query })
  // A full scan before IVF is on, to check the probed results against.
  const [fullBest] = await index.search({ query: queryVector, k: 1 })

  // Four lists, one probed per search: each query scans about a quarter of
  // the index. A higher nProbe finds more true neighbours and costs more.
  console.log('▸ Building IVF lists...')
  const { ivf } = await index.setIvf({ nLists: 4, nProbe: 1 })
  if (!ivf?.built) throw new Error('setIvf() did not build the IVF lists')
  console.log(`▸ IVF on: ${ivf.nLists} lists, ${ivf.nProbe} probed per search`)

  console.log('▸ Searching...')
  const hits = await index.search({ query: queryVector, k: 2 })
  console.log('▸ Top matches:')
  for (const hit of hits) {
    console.log(`  score=${hit.score.toFixed(4)} id=${hit.id}: ${documents.get(hit.id)}`)
  }

  // nProbe on one call overrides the setting for that call only. Probing
  // every list scans the whole index, so it agrees with the full scan.
  const [widerBest] = await index.search({ query: queryVector, k: 1, nProbe: ivf.nLists })
  if (!widerBest || widerBest.id !== fullBest?.id) {
    throw new Error(
      `Probing every list returned id=${widerBest?.id} but the full scan returned id=${fullBest?.id}`
    )
  }
  console.log(`▸ Probing all ${ivf.nLists} lists agrees with the full scan: id=${widerBest.id}`)

  // An add makes the lists stale. Search scans every vector until setIvf()
  // builds them again.
  const extra = 'Neptune has the fastest winds of any planet in the solar system.'
  const { embedding: extraVector } = await embed({ modelId, text: extra })
  await index.add({ ids: ['17'], vectors: [extraVector] })
  documents.set('17', extra)
  console.log(`▸ Added a document; IVF lists built: ${index.ivf?.built}`)
  await index.setIvf({ nLists: 4, nProbe: 1 })
  console.log(`▸ Rebuilt the IVF lists; built: ${index.ivf?.built}`)

  // Null turns IVF off, and search scans every vector again.
  await index.setIvf(null)
  console.log(`▸ IVF off: ${index.ivf === null}`)

  await index.dispose()
  await unloadModel({ modelId })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
