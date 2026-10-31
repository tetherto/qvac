// Ingests documents with precomputed embeddings and runs a scoped search.
// Run from the package root after `npm run build`:
//   bare examples/quickstart.ts
import Corestore from 'corestore'
import { createRag, type EmbeddingSpace } from '@qvac/rag'

const space: EmbeddingSpace = {
  model: 'toy-embedder',
  revision: '1',
  dimensions: 3,
  metric: 'cosine',
  normalized: false,
  documentEncoding: '',
  queryEncoding: '',
  preprocessing: 'none'
}

const corestore = new Corestore('./.quickstart-store')
const rag = createRag({ corestore })
await rag.ready()

const { spaceId } = await rag.createNamespace({ name: 'pets', space })

await rag.ingest({
  namespace: 'pets',
  documents: [
    {
      id: 'cats',
      chunks: [
        { content: 'Cats sleep most of the day.', embedding: [0.9, 0.1, 0], spaceId },
        { content: 'Cats groom themselves.', embedding: [0.8, 0.2, 0.1], spaceId }
      ]
    },
    {
      id: 'dogs',
      chunks: [{ content: 'Dogs need daily walks.', embedding: [0.1, 0.9, 0], spaceId }]
    }
  ]
})

const everything = await rag.search({ scope: { namespace: 'pets' }, vector: [1, 0, 0], k: 3 })
console.log(
  'namespace-wide:',
  everything.map((hit) => hit.content)
)

const dogsOnly = rag.scoped({ namespace: 'pets', documentIds: ['dogs'] })
const hits = await dogsOnly.search({ vector: [1, 0, 0], k: 3 })
console.log(
  'dogs only:',
  hits.map((hit) => hit.content)
)

await rag.close()
await corestore.close()
