import test from 'brittle'
import { RAG } from '../../src/RAG.js'
import { RetrievalService } from '../../src/services/RetrievalService.js'
import { BaseLlmAdapter } from '../../src/adapters/llm/BaseLlmAdapter.js'
import { QvacErrorRAG, ERR_CODES } from '../../src/errors.js'

type RAGConfig = ConstructorParameters<typeof RAG>[0]
type RetrievalServiceConfig = ConstructorParameters<typeof RetrievalService>[0]

// Callers reaching these entry points from plain JS are not bound by the
// declared string type, so both non-string and blank queries are covered.
const NON_STRING_QUERIES: unknown[] = [null, undefined, 123, {}, [], true]
const BLANK_QUERIES = ['', '   ']

// Records logger calls so a test can assert the query is validated before
// anything reads from it. reset() drops whatever was logged while wiring up
// the subject, so the assertion only covers the call under test.
function createSpyLogger() {
  const calls: string[] = []
  return {
    calls,
    reset() {
      calls.length = 0
    },
    debug(msg: string) {
      calls.push(msg)
    },
    info(msg: string) {
      calls.push(msg)
    },
    warn(msg: string) {
      calls.push(msg)
    },
    error(msg: string) {
      calls.push(msg)
    }
  }
}

type SpyLogger = ReturnType<typeof createSpyLogger>

function createRetrievalService(logger: SpyLogger = createSpyLogger()) {
  return new RetrievalService({
    dbAdapter: {
      // lunte-disable-next-line require-await
      search: async () => []
    },
    chunkingService: {
      // lunte-disable-next-line require-await
      chunkText: async (docs: unknown) => docs
    },
    embeddingService: {
      // lunte-disable-next-line require-await
      generateEmbeddings: async () => [0.1, 0.2, 0.3]
    },
    logger
  } as unknown as RetrievalServiceConfig)
}

class StubLlmAdapter extends BaseLlmAdapter {
  // lunte-disable-next-line require-await
  async run(): Promise<unknown> {
    return 'stub response'
  }
}

function createRag(logger: SpyLogger = createSpyLogger()) {
  return new RAG({
    llm: new StubLlmAdapter(),
    // lunte-disable-next-line require-await
    embeddingFunction: async () => [0.1, 0.2, 0.3],
    dbAdapter: {
      // lunte-disable-next-line require-await
      search: async () => []
    },
    logger
  } as unknown as RAGConfig)
}

// Both entry points guard the query the same way, so they run the same table.
const SUBJECTS = [
  {
    label: 'RetrievalService.search',
    create: (logger?: SpyLogger) => createRetrievalService(logger),
    call: (subject: unknown, query: unknown) =>
      (subject as RetrievalService).search(query as string)
  },
  {
    label: 'RAG.infer',
    create: (logger?: SpyLogger) => createRag(logger),
    call: (subject: unknown, query: unknown) => (subject as RAG).infer(query as string)
  }
]

for (const { label, create, call } of SUBJECTS) {
  test(`${label}: rejects non-string queries with QvacErrorRAG`, async (t) => {
    for (const query of NON_STRING_QUERIES) {
      try {
        await call(create(), query)
        t.fail(`Should throw error for non-string query: ${String(query)}`)
      } catch (err) {
        t.ok(err instanceof QvacErrorRAG, `Should throw QvacErrorRAG for ${String(query)}`)
        t.is(
          (err as QvacErrorRAG).code,
          ERR_CODES.INVALID_INPUT,
          'Should have INVALID_INPUT error code'
        )
      }
    }
  })

  test(`${label}: rejects blank queries with QvacErrorRAG`, async (t) => {
    for (const query of BLANK_QUERIES) {
      try {
        await call(create(), query)
        t.fail(`Should throw error for blank query: "${query}"`)
      } catch (err) {
        t.ok(err instanceof QvacErrorRAG, `Should throw QvacErrorRAG for "${query}"`)
        t.is(
          (err as QvacErrorRAG).code,
          ERR_CODES.INVALID_INPUT,
          'Should have INVALID_INPUT error code'
        )
      }
    }
  })

  test(`${label}: validates the query before logging it`, async (t) => {
    const logger = createSpyLogger()
    const subject = create(logger)
    logger.reset()

    try {
      await call(subject, '   ')
      t.fail('Should throw error for blank query')
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Should throw QvacErrorRAG')
    }

    t.is(logger.calls.length, 0, 'Should not log the query before it is validated')
  })
}

test('RetrievalService.search: accepts a valid query', async (t) => {
  const service = createRetrievalService()

  const results = await service.search('what is qvac')
  t.ok(Array.isArray(results), 'Should return result array')
})
