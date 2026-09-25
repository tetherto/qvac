import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  audioEdit,
  audioGen,
  audioUnderstand,
  batchCompletion,
  bciTranscribe,
  bciTranscribeStream,
  loggingStream,
  SDK_LOG_ID,
  cancel,
  classify,
  completion,
  createVectorIndex,
  deleteCache,
  diffusion,
  downloadAsset,
  embed,
  finetune,
  getLoadedModelInfo,
  getModelInfo,
  getSystemResources,
  heartbeat,
  invokePlugin,
  invokePluginStream,
  loadModel,
  loadVectorIndex,
  modelRegistryGetModel,
  modelRegistryList,
  modelRegistrySearch,
  ocr,
  ragCloseWorkspace,
  ragDeleteWorkspace,
  ragIngest,
  resume,
  state,
  suspend,
  textToSpeech,
  transcribe,
  transcribeStream,
  translate,
  unloadModel,
  upscale,
  vla,
  vlaHparams,
  vlaSetEmbodiment,
  worldCreateScene,
  worldStep,
  AUDIOGEN_INPUT_SAMPLE_RATE,
  AUDIOGEN_INPUT_CHANNELS
} from '@qvac/sdk'
import { StepIncompleteError, type CollectMode, type StepBindings } from '@qvac/test-suite'
import type { ResourceManager } from './resource-manager.js'
import { decodeWavToMonoF32, f32ToLeBytes } from './wav-pcm.js'

/**
 * How the shared step interpreter reaches this SDK.
 *
 * The framework knows nothing about `@qvac/sdk`; it asks these bindings to
 * load a model behind a resource key and to make a call. Everything else —
 * reference resolution, ordering, what counts as pass / fail / incomplete —
 * lives in the interpreter, once, and is therefore identical on every client.
 *
 * Calls go through the public SDK surface on purpose. A binding that reached
 * past it into the worker would prove only that the engine works, which is not
 * the question: the question is whether two clients driving the same engine
 * agree.
 */

/**
 * Contract method name -> the SDK function that serves it.
 *
 * Deliberately explicit rather than reflective: a typo in a step should be a
 * clear `incomplete` from the interpreter, not a mystery at call time. Grows
 * one entry at a time as categories migrate.
 */
const CALLS: Record<string, (params: never) => Promise<unknown>> = {
  // --- inference, request/reply -------------------------------------------
  embed: (params) => embed(params),
  classify: async (params) => ({ results: await classify(params) }),
  /**
   * One transcription, bound under the name that says what came back:
   * `metadata` swaps the flat transcript for per-segment records, so a body
   * that projected `text` off a metadata run would be reading segments under
   * a field that promises a string.
   */
  transcribe: async (params) => {
    const result = await transcribe(params)
    return (params as { metadata?: boolean }).metadata === true
      ? { segments: result }
      : { text: result }
  },
  bciTranscribe: async (params) => ({ text: await bciTranscribe(params) }),
  vla: (params) => vla(params),
  vlaHparams: (params) => vlaHparams(params),
  vlaSetEmbodiment: (params) => vlaSetEmbodiment(params),

  // --- models --------------------------------------------------------------
  /**
   * Loads a model, and optionally records what the loader reported on the way.
   *
   * `withProgress` is how a step asks for the `onProgress` callback a catalog
   * cannot pass: the events are collected here and handed back as data. It is
   * the only way to tell a cache hit from a re-download from outside -- a hit
   * reports at most a final 100% per file, a real download reports partials.
   */
  loadModel: async (params: never) => {
    const p = params as { withProgress?: boolean }
    if (!p.withProgress) return { modelId: await loadModel(params) }
    const progress: unknown[] = []
    const { withProgress: _ignored, ...rest } = p as Record<string, unknown>
    const modelId = await loadModel({
      ...(rest as Parameters<typeof loadModel>[0]),
      onProgress: (event: unknown) => {
        progress.push(event)
      }
    } as never)
    return { modelId, progress }
  },
  unloadModel: (params) => unloadModel(params),
  getModelInfo: (params) => getModelInfo(params),
  getLoadedModelInfo: (params) => getLoadedModelInfo(params),

  // --- registry ------------------------------------------------------------
  // The trio takes its arguments differently in each language -- positional
  // here, keyword in Python. The contract name and the params object in the
  // step are what both sides agree on; adapting to the local signature is
  // precisely what a binding is for.
  modelRegistryList: () => modelRegistryList(),
  modelRegistrySearch: (params) => modelRegistrySearch(params),
  modelRegistryGetModel: (params: never) => {
    const p = params as unknown as { registryPath: string; registrySource: string }
    return modelRegistryGetModel(p.registryPath, p.registrySource)
  },

  // --- runtime and host ----------------------------------------------------
  cancel: (params) => cancel(params),
  deleteCache: (params) => deleteCache(params),
  downloadAsset: async (params) => ({ path: await downloadAsset(params) }),
  getSystemResources: (params) => getSystemResources(params),
  heartbeat: () => heartbeat(),
  suspend: async () => {
    await suspend()
    return { suspended: true }
  },
  resume: async () => {
    await resume()
    return { resumed: true }
  },
  state: async () => ({ state: await state() }),

  // --- rag and vector index ------------------------------------------------
  ragIngest: (params) => ragIngest(params),
  ragCloseWorkspace: async (params) => {
    await ragCloseWorkspace(params)
    return { closed: true }
  },
  ragDeleteWorkspace: async (params) => {
    await ragDeleteWorkspace(params)
    return { deleted: true }
  },
  // The vector index is a handle API: `createVectorIndex` hands back an object
  // with methods on it, and a step can only name a method and pass data. So
  // the handle is kept here, keyed by the id the worker gave it, and every
  // operation takes that id -- which is also what the wire protocol does, and
  // therefore what a client without a handle wrapper can reproduce.
  createVectorIndex: async (params) => describeIndex(await createVectorIndex(params)),
  loadVectorIndex: async (params) => describeIndex(await loadVectorIndex(params)),
  vectorIndexAdd: async (params: never) => {
    const p = params as { indexId: string; ids: unknown[]; vectors: number[][] }
    return await vectorIndex(p.indexId).add({ ids: p.ids as never, vectors: p.vectors })
  },
  vectorIndexSearch: async (params: never) => {
    const p = params as { indexId: string; query: number[]; k: number }
    return { results: await vectorIndex(p.indexId).search({ query: p.query, k: p.k }) }
  },
  vectorIndexRemove: async (params: never) => {
    const p = params as { indexId: string; ids: unknown[] }
    const index = vectorIndex(p.indexId)
    const removed = await index.remove({ ids: p.ids as never })
    return { removed, length: index.length }
  },
  vectorIndexContains: async (params: never) => {
    const p = params as { indexId: string; ids: unknown[] }
    return { present: await vectorIndex(p.indexId).contains({ ids: p.ids as never }) }
  },
  vectorIndexWrite: async (params: never) => {
    const p = params as { indexId: string; path: string }
    return await vectorIndex(p.indexId).write({ path: p.path })
  },
  vectorIndexDispose: async (params: never) => {
    const p = params as { indexId: string }
    const index = VECTOR_INDEXES.get(p.indexId)
    if (!index) return { disposed: false }
    await index.dispose()
    VECTOR_INDEXES.delete(p.indexId)
    return { disposed: true }
  },
  vectorIndexLength: async (params: never) => {
    const p = params as { indexId: string }
    return { length: vectorIndex(p.indexId).length }
  },

  // --- plugins -------------------------------------------------------------
  invokePlugin: async (params) => ({ result: await invokePlugin(params) }),

  // --- transcription sessions ----------------------------------------------
  //
  // `transcribeStream` is a duplex session: open it, write audio, end the
  // input, then read events off it. A step can only name a method and pass
  // data, so the session stays in this registry and the catalog addresses it
  // by the id given out here -- the same shape the vector index takes, for the
  // same reason.
  transcribeStreamOpen: async (params: never) => {
    const p = params as Record<string, unknown>
    // `transcribeStream` is overloaded on its parameters and TypeScript picks
    // the pull-stream signature for a `never`; the duplex session is what it
    // actually returns for these calls.
    const session = (await transcribeStream(p as never)) as unknown as TranscribeSession
    const sessionId = `session-${++transcribeSessionSeq}`
    TRANSCRIBE_SESSIONS.set(sessionId, session)
    return { sessionId }
  },

  /**
   * Feeds a WAV fixture in, paced.
   *
   * Parakeet's stream session is built for live audio and only emits segments
   * when the feed is wall-clock paced -- flooding the duplex RPC with the
   * whole clip at once comes back with nothing. `chunkMs` is therefore both
   * the chunk size and the delay between chunks, and `trailingSilenceMs` is
   * the pad that lets end-of-turn detection fire.
   */
  transcribeStreamWrite: async (params: never) => {
    const p = params as {
      sessionId: string
      audio: Uint8Array
      chunkMs: number
      trailingSilenceMs?: number
      sampleFormat?: 's16le' | 'f32le'
      expectSampleRate?: number
      pace?: boolean
    }
    const session = transcribeSession(p.sessionId)
    const decoded = decodeWavToMonoF32(p.audio)
    const expected = p.expectSampleRate ?? 16000
    if (decoded.sampleRate !== expected) {
      throw new Error(`fixture sample rate ${decoded.sampleRate} != expected ${expected}`)
    }
    const bytesPerSample = p.sampleFormat === 'f32le' ? 4 : 2
    const speech =
      p.sampleFormat === 'f32le'
        ? f32ToLeBytes(decoded.samplesMono)
        : f32ToS16LeBytes(decoded.samplesMono)
    const silenceSamples = Math.floor(((p.trailingSilenceMs ?? 0) / 1000) * decoded.sampleRate)
    const silence = new Uint8Array(silenceSamples * bytesPerSample)
    const chunkSize = Math.floor((p.chunkMs / 1000) * decoded.sampleRate) * bytesPerSample
    const delay = p.pace === false ? 0 : p.chunkMs

    let chunks = 0
    for (const bytes of [speech, silence]) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        session.write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
        chunks++
        if (delay > 0 && offset + chunkSize < bytes.length) {
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }
    return { chunks, bytes: speech.byteLength + silence.byteLength }
  },

  /** Writes a fixed number of chunks and stops, for the teardown tests. */
  transcribeStreamWriteChunks: async (params: never) => {
    const p = params as { sessionId: string; audio: Uint8Array; chunkMs: number; chunks: number }
    const session = transcribeSession(p.sessionId)
    const decoded = decodeWavToMonoF32(p.audio)
    const speech = f32ToS16LeBytes(decoded.samplesMono)
    const chunkSize = Math.floor((p.chunkMs / 1000) * decoded.sampleRate) * 2
    let written = 0
    for (let i = 0; i < p.chunks; i++) {
      const offset = i * chunkSize
      if (offset >= speech.length) break
      session.write(speech.subarray(offset, Math.min(offset + chunkSize, speech.length)))
      written++
    }
    return { chunks: written }
  },

  /**
   * Opens a log stream and starts buffering.
   *
   * Three steps rather than one, because the executors were three things: the
   * stream has to be open before the operation that produces the logs runs,
   * the cutoff has to be taken when that operation starts -- otherwise
   * buffered load logs satisfy the target on their own -- and only then can
   * the reading be bounded.
   */
  loggingStreamOpen: async (params: never) => {
    const p = params as { id?: string }
    const id = p.id ?? SDK_LOG_ID
    const collected: LogEntry[] = []
    const streamId = `logs-${++loggingStreamSeq}`
    const state: LoggingStream = { collected, cutoffMs: 0, done: false }
    LOGGING_STREAMS.set(streamId, state)
    // Read in the background: the catalog triggers the operation between this
    // step and the collect, and nothing would be listening in between.
    state.pump = (async () => {
      try {
        for await (const entry of loggingStream({ id })) {
          if (state.done) break
          collected.push(entry as LogEntry)
        }
      } catch {
        // An unknown id closes the stream; the collect step reports the count,
        // which for that case is the assertion.
      }
    })()
    return { streamId }
  },

  /** Marks the point the logs are counted from. */
  loggingStreamMark: async (params: never) => {
    const state = loggingStreamState((params as { streamId: string }).streamId)
    state.cutoffMs = Date.now()
    return { markedAt: state.cutoffMs }
  },

  /**
   * Reads until enough entries have arrived past the mark, or the window
   * closes.
   *
   * The window is a bound, not a wait: a test that got its entries early
   * returns as soon as it has them.
   */
  loggingStreamCollect: async (params: never) => {
    const p = params as { streamId: string; target?: number; timeoutMs?: number }
    const state = loggingStreamState(p.streamId)
    const target = p.target ?? 1
    const deadline = Date.now() + (p.timeoutMs ?? 5000)
    const since = () => state.collected.filter((entry) => entry.timestamp >= state.cutoffMs)
    while (since().length < target && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { entries: since() }
  },

  /** Closes the stream, on both paths. */
  loggingStreamClose: async (params: never) => {
    const streamId = (params as { streamId?: string }).streamId
    const state = streamId ? LOGGING_STREAMS.get(streamId) : undefined
    if (!state) return { closed: false }
    state.done = true
    LOGGING_STREAMS.delete(streamId as string)
    return { closed: true }
  },

  /**
   * The BCI duplex session, in the same registry as the transcription ones.
   *
   * Its input is raw neural samples rather than audio, so it has its own open
   * and its own write; everything after that -- end, drain, destroy -- is the
   * same session surface.
   */
  bciTranscribeStreamOpen: async (params: never) => {
    const session = (await bciTranscribeStream(params as never)) as unknown as TranscribeSession
    const sessionId = `session-${++transcribeSessionSeq}`
    TRANSCRIBE_SESSIONS.set(sessionId, session)
    return { sessionId }
  },

  /**
   * Writes a fixture in fixed-size chunks, with no decoding.
   *
   * The neural fixture is already in the form the addon wants, so unlike the
   * audio writer this one does not touch the bytes -- which is the whole
   * difference between the two inputs.
   */
  transcribeStreamWriteBytes: async (params: never) => {
    const p = params as { sessionId: string; data: Uint8Array; chunkBytes: number }
    const session = transcribeSession(p.sessionId)
    let chunks = 0
    for (let offset = 0; offset < p.data.byteLength; offset += p.chunkBytes) {
      session.write(p.data.subarray(offset, offset + p.chunkBytes))
      chunks++
    }
    return { chunks, bytes: p.data.byteLength }
  },

  transcribeStreamEnd: async (params: never) => {
    transcribeSession((params as { sessionId: string }).sessionId).end()
    return { ended: true }
  },

  /**
   * Tears the session down and forgets it.
   *
   * Tolerant of a session already gone: teardown runs on the failure path too,
   * and a body that failed before opening one must not fail again here.
   */
  transcribeStreamDestroy: async (params: never) => {
    const p = params as { sessionId?: string }
    const session = p.sessionId ? TRANSCRIBE_SESSIONS.get(p.sessionId) : undefined
    if (!session) return { destroyed: false }
    TRANSCRIBE_SESSIONS.delete(p.sessionId as string)
    try {
      session.destroy()
    } catch {
      // Already torn down by the iterator; nothing to undo.
    }
    return { destroyed: true }
  },

  // --- world ---------------------------------------------------------------
  worldCreateScene: async (params: never) => {
    const run = worldCreateScene(params)
    const p = params as { returnPack?: boolean }
    // The pack is ~14 MB base64 on the wire, so only the test that asserts on
    // it asks for it -- the walk tests just need the world live on the
    // session, and `stats` is their completion signal.
    return {
      requestId: run.requestId,
      stats: await run.stats,
      ...(p.returnPack ? { scene: await run.scene } : {})
    }
  }
}

/** Every value of an async iterator, in order. */
async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const value of source) out.push(value)
  return out
}

/** Concatenate the pieces of a text stream. */
async function joinStream(source: AsyncIterable<string>): Promise<string> {
  let text = ''
  for await (const piece of source) text += piece
  return text
}

/**
 * How a streaming call is folded into one value, per method.
 *
 * The fold is the interesting half of a streaming binding: two clients are
 * only running the same test if "the text of this completion" or "the frames
 * of this block" means the same thing on both. Each entry returns an object so
 * a later `project` step has a field to pull, and the field is named after the
 * fold -- `text`, `blocks`, `events`, `pcm`, `last`, `all` -- so a definition
 * reads the same regardless of which SDK produced the value.
 *
 * A method that has no entry for the mode a step asked for reports
 * `incomplete`. That is a gap in these bindings, not a failing test.
 */
type Fold = (params: never, collect: CollectMode) => Promise<unknown>

const STREAMS: Record<string, Fold> = {
  completion: async (params, collect) => {
    const run = completion(params)
    // `toolCalls` rides along with `text` because a tools test needs both: the
    // model either answered or called a tool, and which one it did is the
    // question. Splitting them across two folds would mean running the
    // completion twice.
    if (collect === 'text') {
      // `stats` and `stopReason` ride along with the text for the same reason
      // `toolCalls` does: a completion is the expensive part, and "how did it
      // stop" and "what did it cost" are questions about the run that just
      // happened, not reasons to run it again.
      const final = await run.final
      return {
        text: await run.text,
        toolCalls: (await run.toolCalls) ?? [],
        stats: final.stats,
        stopReason: final.stopReason,
        fullText: final.raw?.fullText
      }
    }
    if (collect === 'events') return { events: await drain(run.events) }
    if (collect === 'all') return { all: await drain(run.tokenStream) }
    throw unsupported('completion', collect)
  },

  translate: async (params, collect) => {
    const p = params as unknown as { stream?: boolean }
    const run = translate(params)
    // `all` carries the joined text beside the tokens: "it streamed, and this
    // is what it said" is one question, and a second fold would be a second
    // translation.
    if (collect === 'all') {
      const all = await drain(run.tokenStream)
      return { all, text: all.join(''), stats: await run.stats }
    }
    if (collect !== 'text') throw unsupported('translate', collect)
    // `text` resolves to the empty string in streaming mode on both clients, so
    // the fold has to follow the mode rather than always await the same handle.
    if (p.stream) return { text: await joinStream(run.tokenStream), stats: await run.stats }
    // `translations` rides along: a batch asks about the entries and about the
    // text they join to, and a second fold would be a second translation.
    return { text: await run.text, translations: await run.translations, stats: await run.stats }
  },

  transcribeStream: async (params, collect) => {
    const pieces = await drain(transcribeStream(params) as AsyncIterable<unknown>)
    if (collect === 'blocks') return { blocks: pieces }
    if (collect === 'all') return { all: pieces }
    if (collect === 'last') return { last: pieces.at(-1) }
    if (collect === 'text') return { text: pieces.map((p) => String(p)).join('') }
    throw unsupported('transcribeStream', collect)
  },

  ocr: async (params, collect) => {
    const p = params as unknown as { stream?: boolean }
    const run = ocr(params)

    // `blocks` resolves empty in streaming mode, the same trap `translate`
    // has: the fold must follow the call's own mode rather than always await
    // the same handle, or a streaming test asserts on nothing and says so
    // only if the expectation happens to be strict.
    const blocks = p.stream ? (await drain(run.blockStream)).flat() : await run.blocks

    // `stats` rides along with every fold: a test that checks timing asks for
    // it from the same run, and a second call would time a different one.
    const stats = await run.stats

    if (collect === 'blocks') return { blocks, stats }
    if (collect === 'all' || collect === 'events') return { all: blocks, events: blocks, stats }
    if (collect === 'text') {
      // Space, not newline: this is what the executors joined with, and a
      // migrated test has to reproduce what its executor produced or it is not
      // migrated.
      return { text: blocks.map((block) => block.text).join(' '), stats }
    }
    throw unsupported('ocr', collect)
  },

  textToSpeech: async (params, collect) => {
    const p = params as unknown as { stream?: boolean }
    const run = textToSpeech(params)
    if (collect === 'pcm') {
      // The fold has to follow the mode. In streaming mode the run starts
      // lazily -- nothing is sent until `bufferStream` is iterated -- so
      // awaiting `buffer` first leaves `sampleRate` and `done` pending for
      // ever and the test dies on its timeout rather than failing. The
      // non-streaming mode is the mirror image: there `bufferStream` is empty
      // and `buffer` is where the audio is.
      const pcm = p.stream === false ? await run.buffer : await drain(run.bufferStream)
      return { pcm, sampleRate: await run.sampleRate, done: await run.done }
    }
    if (collect === 'all') return { all: await drain(run.bufferStream) }
    if (collect === 'events') {
      return { events: run.chunkUpdates ? await drain(run.chunkUpdates) : [] }
    }
    throw unsupported('textToSpeech', collect)
  },

  diffusion: async (params, collect) => imagesRun(diffusion(params), collect, 'diffusion'),
  upscale: async (params, collect) => imagesRun(upscale(params), collect, 'upscale'),

  audioGen: async (params, collect) => audioRun(audioGen(params), collect, 'audioGen'),
  audioEdit: async (params, collect) => audioRun(audioEdit(params), collect, 'audioEdit'),

  audioUnderstand: async (params, collect) => {
    const run = audioUnderstand(params)
    if (collect === 'text') return { text: await run.description }
    if (collect === 'events') return { events: await drain(run.progressStream) }
    throw unsupported('audioUnderstand', collect)
  },

  batchCompletion: async (params, collect) => {
    const run = batchCompletion(params)
    if (collect === 'all') {
      // Events are drained alongside the results: a streaming batch test asks
      // whether every prompt produced deltas *and* whether its final agrees
      // with them, and a second fold would be a second batch.
      //
      // Both are awaited through one `Promise.all` rather than in sequence.
      // An empty batch rejects both, and awaiting them one after the other
      // leaves the second rejection with nobody listening -- which takes the
      // whole consumer process down on a test that had already passed.
      const [all, events] = await Promise.all([run.results, drain(run.events)])
      return { all, events }
    }
    if (collect === 'events') return { events: await drain(run.events) }
    throw unsupported('batchCompletion', collect)
  },

  worldStep: async (params, collect) => {
    const run = worldStep(params)
    // `frames` is the same array the generator would hand back one at a time,
    // filled by the run's own pump whether or not anyone iterates. Draining the
    // generator instead would double-buffer every image frame to arrive at the
    // identical value.
    // `stats` rides along with every fold: the action mask and the step count
    // are what a walk test is actually about, and a block takes long enough
    // that asking for them through a second `collect` would mean walking
    // twice.
    if (collect === 'all') {
      const frames = await run.frames
      return { all: frames, frameCount: frames.length, stats: await run.stats }
    }
    if (collect === 'last') {
      const frames = await run.frames
      return { last: frames.at(-1), frameCount: frames.length, stats: await run.stats }
    }
    if (collect === 'events') {
      const frames = await run.frames
      return {
        events: await drain(run.progressStream),
        frameCount: frames.length,
        stats: await run.stats
      }
    }
    throw unsupported('worldStep', collect)
  },

  finetune: async (params, collect) => {
    // A control operation -- pause, resume, stop -- is a plain call that
    // resolves; only a run without one produces a handle with a progress
    // stream and a result. Folding a control call as though it had a `result`
    // awaited `undefined`, which resolves, so a refusal read as success.
    const p = params as unknown as { operation?: string }
    if (p.operation) return { last: await (finetune(params) as unknown as Promise<unknown>) }
    const handle = finetune(params)
    if (collect === 'events') {
      const events = await drain(handle.progressStream)
      return { events, last: await handle.result }
    }
    if (collect === 'last') return { last: await handle.result }
    throw unsupported('finetune', collect)
  },

  /**
   * Reads the session's events to the end, or up to `abortAfter` of them.
   *
   * `abortAfter` is the consumer-disconnect path: the iterator is thrown into
   * after that many events, which must unwind the native session cleanly. A
   * body that merely stopped reading would prove nothing -- the question is
   * what happens when the consumer goes away mid-stream.
   */
  transcribeStreamDrain: async (params, collect) => {
    const p = params as unknown as { sessionId: string; abortAfter?: number }
    if (collect !== 'events') throw unsupported('transcribeStreamDrain', collect)
    const session = transcribeSession(p.sessionId)
    const events: Record<string, unknown>[] = []
    const iterator = session[Symbol.asyncIterator]()
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      events.push(normaliseTranscribeEvent(next.value))
      if (p.abortAfter !== undefined && events.length >= p.abortAfter) {
        // `throw` rather than `return`: the contract under test is that the
        // session unwinds when the consumer errors, not when it finishes.
        //
        // A generator that does not catch what is thrown into it re-raises it
        // out of `.throw()`. That rejection is this step's own abort arriving
        // back, not a failure, so it is swallowed here -- letting it escape
        // would fail the test for doing exactly what it set out to do.
        try {
          await iterator.throw?.(new Error('consumer aborted the stream'))
        } catch {
          // expected: the session unwound by rethrowing
        }
        break
      }
    }
    // The same abort that unwound the iterator also settles `stats` as a
    // rejection, so an aborted drain reports no stats rather than failing:
    // the abort is the point of the test, not an error in it.
    let stats: unknown
    try {
      stats = session.stats ? await session.stats : undefined
    } catch (error) {
      if (p.abortAfter === undefined) throw error
    }
    return { events, stats }
  },

  invokePluginStream: async (params, collect) => {
    const chunks = await drain(invokePluginStream(params))
    if (collect === 'all') return { all: chunks }
    if (collect === 'last') return { last: chunks.at(-1) }
    if (collect === 'text') return { text: chunks.map((c) => String(c)).join('') }
    throw unsupported('invokePluginStream', collect)
  }
}

/**
 * `diffusion` and `upscale` return the same handle, so they fold the same.
 *
 * Every fold carries the stats and the progress ticks beside the images: one
 * generation is minutes of work, and a test that asked "did it report phase
 * timings" through a second `collect` would be paying that twice to ask about
 * the first run.
 */
async function imagesRun(
  run: {
    outputs: Promise<unknown[]>
    // `upscale` reports no progress, so the field is optional rather than
    // faked: a body that asked for `events` on it gets an empty list, which is
    // the truth.
    progressStream?: AsyncIterable<unknown>
    stats: Promise<unknown>
  },
  collect: CollectMode,
  method: string
): Promise<unknown> {
  if (collect !== 'events' && collect !== 'all' && collect !== 'last') {
    throw unsupported(method, collect)
  }
  // Progress is drained first because the generator is the live side of the
  // same stream; awaiting the outputs first would leave nothing to iterate.
  // One `Promise.all` rather than sequential awaits, so a run that rejects
  // does not leave a second promise unhandled.
  const [events, outputs, stats] = await Promise.all([
    run.progressStream ? drain(run.progressStream) : Promise.resolve([]),
    run.outputs,
    run.stats
  ])
  if (collect === 'events') return { events, all: outputs, stats }
  if (collect === 'last') return { last: outputs.at(-1), events, stats }
  return { all: outputs, events, stats }
}

/** `audioGen` and `audioEdit` return the same handle, so they fold the same. */
async function audioRun(
  run: {
    audio: Promise<unknown>
    progressStream: AsyncIterable<unknown>
    stats: Promise<unknown>
  },
  collect: CollectMode,
  method: string
): Promise<unknown> {
  if (collect === 'pcm') {
    // Progress is drained alongside the audio rather than in a second fold:
    // these tests ask whether one run produced audio *and* reported progress,
    // and a second `collect` would be a second generation -- minutes of work
    // answering a question about the first one.
    // One `Promise.all`, not three awaits in a row: a run that rejects rejects
    // all of them, and a rejection awaited second has nobody listening when
    // the first one throws -- an unhandled rejection that ends the consumer.
    const [audio, stats, events] = (await Promise.all([
      run.audio,
      run.stats,
      drain(run.progressStream)
    ])) as [
      { pcm: unknown; sampleRate: unknown; channels: unknown; bitsPerSample: unknown },
      unknown,
      unknown[]
    ]
    // Spelled out rather than passed through: Python's run hands back the same
    // four values under `data`, so naming them here is what makes
    // `$run.audio.pcm` one thing in both clients.
    return {
      audio: {
        pcm: audio.pcm,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        bitsPerSample: audio.bitsPerSample
      },
      stats,
      events
    }
  }
  if (collect === 'events') {
    const events = await drain(run.progressStream)
    await run.audio
    return { events }
  }
  throw unsupported(method, collect)
}

function unsupported(method: string, collect: CollectMode): StepIncompleteError {
  return new StepIncompleteError(`collect: "${collect}" is not defined for ${method}`)
}

/**
 * Where a test asset lives on this platform.
 *
 * The whole reason the OCR tests have two executors today — one under `node/`,
 * one under `mobile/` — is nothing but this: a filesystem path here, a
 * bundled-asset URI there. Once resolution is a step the interpreter performs,
 * that split collapses.
 *
 * Desktop and Electron read from the checkout; a mobile binding would resolve
 * the same `kind`/`file` pair through Metro instead, and the definition would
 * not change.
 */
/**
 * A fixture the catalog names but no file holds: `"2s-440hz"` is two seconds of
 * a 440 Hz tone.
 *
 * The audio tests feed a synthesized tone rather than a recording because the
 * point is a known signal, not a performance. Generating it from the name
 * keeps it a fixture both clients resolve identically -- checking in a wav
 * would work too, but then "the same source audio" would rest on a binary
 * nobody reads.
 */
const TONE = /^(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)hz$/

/** Raw interleaved stereo 48 kHz Float32 LE PCM, the form AudioGen accepts. */
const synthesizeTone = (spec: string): Uint8Array => {
  const match = TONE.exec(spec)
  if (!match) throw new Error(`tone "${spec}" is not "<seconds>s-<frequency>hz"`)
  const [seconds, frequency] = [Number(match[1]), Number(match[2])]
  const frames = Math.round(AUDIOGEN_INPUT_SAMPLE_RATE * seconds)
  const pcm = new Float32Array(frames * AUDIOGEN_INPUT_CHANNELS)
  for (let frame = 0; frame < frames; frame++) {
    const sample = 0.1 * Math.sin((2 * Math.PI * frequency * frame) / AUDIOGEN_INPUT_SAMPLE_RATE)
    for (let channel = 0; channel < AUDIOGEN_INPUT_CHANNELS; channel++) {
      pcm[frame * AUDIOGEN_INPUT_CHANNELS + channel] = sample
    }
  }
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

/**
 * A fixture spelled out in hex: `"00010203"` is four bytes.
 *
 * For the deliberately malformed inputs -- four bytes that cannot be a JPEG,
 * a truncated header. Checking such a file in would hide what makes it invalid
 * behind a binary; written in the catalog, the test says it.
 */
const synthesizeBytes = (spec: string): Uint8Array => {
  if (spec.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(spec)) {
    throw new Error(`bytes "${spec}" is not an even-length hex string`)
  }
  const out = new Uint8Array(spec.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(spec.slice(i * 2, i * 2 + 2), 16)
  return out
}

const ASSET_ROOTS: Record<string, string> = {
  image: 'assets/images',
  audio: 'assets/audio',
  document: 'assets/documents',
  neural: 'assets/neural'
}

/** One entry of the log stream, as both clients report it. */
type LogEntry = { timestamp: number; level: string; namespace: string; message: string }

type LoggingStream = {
  collected: LogEntry[]
  cutoffMs: number
  done: boolean
  pump?: Promise<void>
}

/** Open log streams, by an id this client hands out. */
const LOGGING_STREAMS = new Map<string, LoggingStream>()
let loggingStreamSeq = 0

const loggingStreamState = (streamId: string): LoggingStream => {
  const state = LOGGING_STREAMS.get(streamId)
  if (!state) throw new Error(`log stream "${streamId}" is not open`)
  return state
}

/**
 * Open transcription sessions, by an id this client hands out.
 *
 * Unlike the vector index the worker assigns no id here, so one is minted:
 * what matters is that the catalog can name the session it opened without
 * holding the object.
 */
type TranscribeSession = {
  write(chunk: Uint8Array): void
  end(): void
  destroy(): void
  stats?: Promise<unknown>
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}

const TRANSCRIBE_SESSIONS = new Map<string, TranscribeSession>()
let transcribeSessionSeq = 0

const transcribeSession = (sessionId: string): TranscribeSession => {
  const session = TRANSCRIBE_SESSIONS.get(sessionId)
  if (!session) throw new Error(`transcription session "${sessionId}" is not open`)
  return session
}

/** Signed 16-bit little-endian PCM, the form the parakeet stream takes. */
const f32ToS16LeBytes = (samples: Float32Array): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, Math.round(clamped * 32767), true)
  }
  return out
}

/**
 * One event as the catalog sees it.
 *
 * The plain session yields bare strings and the conversation session yields
 * records; both become `{ type, ... }` here so a body can count event types
 * without knowing which mode the session was opened in -- and so the Python
 * client, whose events are typed objects with snake_case fields, reports the
 * same shape.
 */
const normaliseTranscribeEvent = (event: unknown): Record<string, unknown> => {
  if (typeof event === 'string') return { type: 'text', text: event }
  return { ...(event as Record<string, unknown>) }
}

/**
 * Live vector indexes, by the id the worker assigned.
 *
 * `createVectorIndex` returns an object with methods; a step can only name a
 * method and pass data, so the object stays here and the id travels through
 * the catalog instead. The id is what the wire protocol keys on anyway, which
 * is what makes the same body runnable by a client that has no handle
 * wrapper.
 */
const VECTOR_INDEXES = new Map<string, Awaited<ReturnType<typeof createVectorIndex>>>()

const describeIndex = (index: Awaited<ReturnType<typeof createVectorIndex>>) => {
  VECTOR_INDEXES.set(index.indexId, index)
  return { indexId: index.indexId, dim: index.dim, storage: index.storage, length: index.length }
}

const vectorIndex = (indexId: string) => {
  const index = VECTOR_INDEXES.get(indexId)
  if (!index) throw new Error(`vector index "${indexId}" is not open in this client`)
  return index
}

/**
 * Scratch directories this run made, so `producedFile` can only be asked
 * about one of them and nothing else on the machine.
 */
const scratchDirectories = new Set<string>()

/** Is this path one of this run's scratch roots, or inside one? */
const withinScratch = (candidate: string): boolean => {
  const resolved = path.resolve(candidate)
  for (const root of scratchDirectories) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true
  }
  return false
}

/**
 * PNG IHDR or JPEG SOF0 dimensions, so both frame encodings are accepted.
 *
 * The world session emits whichever its encoder produced, and a test about the
 * picture should not care which.
 */
const readFrameDimensions = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  const png = readPngDimensions(bytes)
  if (png) return png
  if (bytes.byteLength < 24 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1] as number
    const length = view.getUint16(offset + 2, false)
    // SOF0..SOF3 -- baseline, extended, progressive and lossless. Excludes
    // 0xC4 (DHT), which shares the 0xCn range but is not a frame header.
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        width: view.getUint16(offset + 7, false),
        height: view.getUint16(offset + 5, false)
      }
    }
    offset += 2 + length
  }
  return undefined
}

/** How much data a value carries, whether it arrived as bytes or a list. */
const byteLength = (value: unknown): number => {
  if (ArrayBuffer.isView(value)) return (value as Uint8Array).byteLength
  if (Array.isArray(value)) return value.length
  return 0
}

const asBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item) & 0xff))
  return new Uint8Array()
}

/**
 * Width and height out of a PNG's IHDR, or nothing if it is not a PNG.
 *
 * PNG byte length varies with content and compression, so the header is the
 * only reliable invariant for comparing two generated images.
 */
const readPngDimensions = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.byteLength < 24) return undefined
  for (const [index, byte] of SIGNATURE.entries()) if (bytes[index] !== byte) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
}

/** How much of the two buffers differs, as a fraction of the longer one. */
const byteDiffRatio = (left: Uint8Array, right: Uint8Array): number => {
  const longest = Math.max(left.byteLength, right.byteLength)
  if (longest === 0) return 0
  let changed = Math.abs(left.byteLength - right.byteLength)
  const shortest = Math.min(left.byteLength, right.byteLength)
  for (let i = 0; i < shortest; i++) if (left[i] !== right[i]) changed++
  return changed / longest
}

const sameBytes = (left: unknown, right: unknown): boolean => {
  const a = asBytes(left)
  const b = asBytes(right)
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Checks that take two bound values rather than one.
 *
 * Distinct from the assertions because the question is about the
 * relationship: the same call made twice with one parameter changed, and the
 * claim is that the results differ -- or do not.
 */
const COMPARISONS: Record<
  string,
  (
    left: unknown,
    right: unknown,
    args: Record<string, unknown>
  ) => {
    passed: boolean
    output: string
  }
> = {
  /**
   * The left number is strictly larger than the right.
   *
   * Two cache-token readings taken either side of a model reload: the second
   * can only exceed the first if the cache was written to disk and read back,
   * because the reload cleared everything held in memory. Equal readings mean
   * the save was silently dropped.
   */
  greaterThan(left, right) {
    const [a, b] = [Number(left), Number(right)]
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return {
        passed: false,
        output: `expected numbers, got ${JSON.stringify(left)} and ${JSON.stringify(right)}`
      }
    }
    if (a <= b) return { passed: false, output: `expected ${a} > ${b}` }
    return { passed: true, output: `${a} > ${b}` }
  },

  /**
   * The two strings are the same.
   *
   * `identicalBytes` reads buffers; a seeded completion is compared as text,
   * and reporting "0 bytes differ" about two strings would be nonsense.
   */
  equalStrings(left, right) {
    if (String(left) !== String(right)) {
      return {
        passed: false,
        output: `differ:\n  ${JSON.stringify(String(left).slice(0, 200))}\n  ${JSON.stringify(String(right).slice(0, 200))}`
      }
    }
    return { passed: true, output: `identical, ${String(left).length} char(s)` }
  },

  /**
   * The two runs produced exactly the same data.
   *
   * The determinism half of a conditioning test: the same inputs twice have to
   * give the same output before "changing this one input changed the output"
   * means anything.
   */
  identicalBytes(left, right) {
    if (!sameBytes(left, right)) {
      return {
        passed: false,
        output: `expected identical output, got ${byteLength(left)} and ${byteLength(right)} byte(s) that differ`
      }
    }
    return { passed: true, output: `identical, ${byteLength(left)} byte(s)` }
  },

  /**
   * The two runs produced different data, and both produced some.
   *
   * Both halves matter: two empty results are trivially different, and a
   * conditioning test that accepted them would pass against a silent engine.
   */
  differentBytes(left, right) {
    if (byteLength(left) === 0 || byteLength(right) === 0) {
      return {
        passed: false,
        output: `one side produced nothing (${byteLength(left)} and ${byteLength(right)} byte(s))`
      }
    }
    if (sameBytes(left, right)) {
      return { passed: false, output: 'expected the outputs to differ, they are identical' }
    }
    return {
      passed: true,
      output: `differ, ${byteLength(left)} vs ${byteLength(right)} byte(s)`
    }
  },

  /**
   * Two images of the same size, and far enough apart to prove the input
   * mattered.
   *
   * The img2img and fusion tests run the same prompt and seed twice, dropping
   * the reference image from one. A backend that silently ignored the
   * reference would produce two nearly identical outputs, so the claim is a
   * floor on how much they differ -- and equal dimensions first, because
   * comparing a 512x512 against a 768x768 says nothing.
   */
  imageDivergesFrom(left, right, args) {
    const a = asBytes(left)
    const b = asBytes(right)
    if (a.byteLength === 0 || b.byteLength === 0) {
      return { passed: false, output: `missing output (${a.byteLength} and ${b.byteLength} bytes)` }
    }
    const da = readPngDimensions(a)
    const db = readPngDimensions(b)
    if (!da || !db) {
      return { passed: false, output: 'one of the outputs is not a valid PNG' }
    }
    if (da.width !== db.width || da.height !== db.height) {
      return {
        passed: false,
        output: `dimensions differ: ${da.width}x${da.height} vs ${db.width}x${db.height} -- the comparison is only meaningful at equal size`
      }
    }
    const ratio = byteDiffRatio(a, b)
    const minimum = Number(args.minRatio ?? 0.01)
    if (ratio <= minimum) {
      return {
        passed: false,
        output: `outputs are ${(ratio * 100).toFixed(2)}% apart, at or below the ${(minimum * 100).toFixed(2)}% floor -- the input was probably dropped`
      }
    }
    return { passed: true, output: `${(ratio * 100).toFixed(2)}% byte delta` }
  },

  /**
   * The left value carries at least this many times the data of the right.
   *
   * The strongest claim available about an output sample rate: the rate itself
   * is not exposed through the public result, but a native-rate run has to
   * produce proportionally more samples than a downsampled one.
   */
  lengthRatioAtLeast(left, right, args) {
    const [leftSize, rightSize] = [byteLength(left), byteLength(right)]
    if (leftSize === 0 || rightSize === 0) {
      return {
        passed: false,
        output: `comparison produced empty output (${leftSize} and ${rightSize})`
      }
    }
    const minimum = Number(args.ratio ?? 1)
    const ratio = leftSize / rightSize
    if (ratio < minimum) {
      return {
        passed: false,
        output: `ratio too low: ${ratio.toFixed(2)} < ${minimum} (${leftSize} vs ${rightSize})`
      }
    }
    return { passed: true, output: `ratio ${ratio.toFixed(2)} (${leftSize} vs ${rightSize})` }
  }
}

/**
 * Named assertions: the checks that are more than "contains this string".
 *
 * These replace the JavaScript-function expectations in the catalog, which
 * cannot cross the wire. The name is part of the shared vocabulary, so two
 * clients checking `loadedModelInfoShape` check the same thing rather than
 * each their own idea of it — which is the difference between a shared catalog
 * that means something and one that only looks shared.
 *
 * `args` is the step's `with` block, already reference-resolved: that is what
 * lets a check compare the result against something the test set up.
 */
const ASSERTIONS: Record<
  string,
  (value: unknown, args: Record<string, unknown>) => { passed: boolean; output: string }
> = {
  /**
   * The collection has exactly the expected number of elements.
   *
   * Deliberately generic: `topK: 1 must truncate to one result` is the same
   * check as "this many blocks came back", and a registry of one-off names
   * would defeat the point of a shared vocabulary.
   */
  lengthIs(value, args) {
    if (!Array.isArray(value)) {
      return { passed: false, output: `expected an array, got ${typeof value}` }
    }
    const expected = Number(args.length)
    if (value.length !== expected) {
      return { passed: false, output: `expected ${expected} element(s), got ${value.length}` }
    }
    return { passed: true, output: `${value.length} element(s)` }
  },

  /**
   * A block of frames: this many, each at this size.
   *
   * Both encodings are read, because which one the engine emits is its
   * business and the claim is about the picture. The count matters as much as
   * the size: the first block after a load is shorter than the ones after it,
   * so a body that only checked dimensions could not tell a fresh session from
   * a continuing one.
   */
  framesAre(value, args) {
    const frames = (Array.isArray(value) ? value : []) as unknown[]
    const expected = Number(args.count)
    if (frames.length !== expected) {
      return { passed: false, output: `expected ${expected} frame(s), got ${frames.length}` }
    }
    const [width, height] = [Number(args.width), Number(args.height)]
    for (const [index, frame] of frames.entries()) {
      const dims = readFrameDimensions(asBytes(frame))
      if (!dims) return { passed: false, output: `frame ${index} is undecodable` }
      if (dims.width !== width || dims.height !== height) {
        return {
          passed: false,
          output: `frame ${index} is ${dims.width}x${dims.height}, expected ${width}x${height}`
        }
      }
    }
    return { passed: true, output: `${expected} frame(s) at ${width}x${height}` }
  },

  /**
   * The bytes are a safetensors container.
   *
   * A cheap structural read of the header, which is what tells a real pack
   * from an error page or a truncated write -- both of which are non-empty
   * byte arrays and would satisfy a length check.
   */
  safetensorsContainer(value, args) {
    const bytes = asBytes(value)
    const floor = Number(args.minBytes ?? 1024)
    if (bytes.byteLength < floor) {
      return {
        passed: false,
        output: `pack is ${bytes.byteLength} bytes, expected at least ${floor}`
      }
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const headerLength = Number(view.getBigUint64(0, true))
    // A little-endian u64 header length, then that many bytes of JSON starting
    // with '{'.
    if (headerLength <= 0 || headerLength + 8 > bytes.byteLength || bytes[8] !== 0x7b) {
      return {
        passed: false,
        output: `not a safetensors container (header length ${headerLength})`
      }
    }
    return { passed: true, output: `${bytes.byteLength} bytes, header ${headerLength}` }
  },

  /**
   * Every batch of every phase reported its progress, with no gaps.
   *
   * A training run emits one update per batch per phase; the engine tells you
   * how many batches a phase has, so a phase that reported fewer unique
   * batches than it declared dropped some. Counting events alone would not
   * catch it -- the total can look healthy while one epoch is missing three
   * batches in the middle.
   */
  noProgressBatchGaps(value) {
    const events = (Array.isArray(value) ? value : []) as Array<Record<string, number | boolean>>
    if (events.length === 0) return { passed: false, output: 'no progress events received' }

    const phases = new Map<string, { batches: Set<number>; total: number }>()
    for (const event of events) {
      const key = `${event['is_train'] ? 'train' : 'val'}:epoch${String(event['current_epoch'])}`
      const total = Number(event['total_batches'])
      let phase = phases.get(key)
      if (!phase) {
        phase = { batches: new Set(), total }
        phases.set(key, phase)
      }
      phase.batches.add(Number(event['current_batch']))
      if (total > phase.total) phase.total = total
    }

    const drops: string[] = []
    for (const [key, phase] of phases) {
      if (phase.batches.size < phase.total) {
        const received = [...phase.batches].sort((a, b) => a - b)
        drops.push(`${key}: ${received.length}/${phase.total} (received=[${received.join(',')}])`)
      }
    }
    if (drops.length > 0) {
      return { passed: false, output: `progress events dropped: ${drops.join('; ')}` }
    }
    return {
      passed: true,
      output: `${events.length} event(s) across ${phases.size} phase(s), no batch gaps`
    }
  },

  /**
   * The list is ordered by the named field, smallest first.
   *
   * Log timestamps: entries arriving out of order would make every
   * time-ordered read of a log stream wrong, without any single entry looking
   * wrong.
   */
  sortedAscendingBy(value, args) {
    const items = (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>
    const field = String(args.field)
    const minimum = Number(args.minimum ?? 2)
    if (items.length < minimum) {
      return { passed: false, output: `need at least ${minimum} element(s), got ${items.length}` }
    }
    for (let i = 1; i < items.length; i++) {
      if (Number(items[i]?.[field]) < Number(items[i - 1]?.[field])) {
        return { passed: false, output: `out of order by ${field} at index ${i}` }
      }
    }
    return { passed: true, output: `${items.length} element(s) in order` }
  },

  /**
   * At least one element reports a finite, positive value for this field.
   *
   * Training loss: a run reports one per step, and some of them legitimately
   * arrive as null or zero before the first backward pass. The claim is that
   * the run produced a real number at some point -- a stream of nulls means
   * the loss never reached the caller, however many updates arrived.
   */
  anyElementPositive(value, args) {
    const items = (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>
    const field = String(args.field)
    const found = items.filter((item) => {
      const measured = item[field]
      return typeof measured === 'number' && Number.isFinite(measured) && measured > 0
    })
    if (found.length === 0) {
      return {
        passed: false,
        output: `no finite positive ${field} across ${items.length} element(s)`
      }
    }
    return { passed: true, output: `${found.length} of ${items.length} had a positive ${field}` }
  },

  /**
   * The number is at least this large.
   *
   * `cacheTokens` on a warm turn: any positive figure means the prefix was
   * reused, and zero means it was not, whatever else the stats say.
   */
  atLeast(value, args) {
    const minimum = Number(args.value)
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { passed: false, output: `expected a number, got ${JSON.stringify(value)}` }
    }
    if (value < minimum) {
      return { passed: false, output: `expected at least ${minimum}, got ${value}` }
    }
    return { passed: true, output: String(value) }
  },

  /**
   * Nothing is there.
   *
   * A completion that ran to its natural end reports no stop reason at all;
   * `null` and `undefined` both mean that, and which one a client uses is a
   * language detail rather than a difference in what happened.
   */
  isAbsent(value) {
    if (value !== undefined && value !== null) {
      return { passed: false, output: `expected nothing, got ${JSON.stringify(value)}` }
    }
    return { passed: true, output: '(absent)' }
  },

  /**
   * The value is a number strictly below the budget.
   *
   * The context-boundary test: stopping for "length" only proves the boundary
   * if the run stopped before the prediction budget ran out, so the budget is
   * the bound rather than the thing being measured.
   */
  belowBudget(value, args) {
    const budget = Number(args.budget)
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { passed: false, output: `expected a number, got ${JSON.stringify(value)}` }
    }
    if (value >= budget) {
      return {
        passed: false,
        output: `expected fewer than the ${budget} budgeted (boundary, not prediction cutoff), got ${value}`
      }
    }
    return { passed: true, output: `${value} of ${budget}` }
  },

  /**
   * One field of the record is at least as large as another.
   *
   * A context overflow reports the prompt it measured and the window it
   * measured against; the guard trips on `>=`, so equality is legitimate and
   * anything below means the parser read the wrong quantity.
   */
  atLeastField(value, args) {
    const record = (value ?? {}) as Record<string, unknown>
    const left = Number(record[String(args.field)])
    const right = Number(record[String(args.atLeast)])
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return {
        passed: false,
        output: `expected numbers, got ${String(args.field)}=${JSON.stringify(record[String(args.field)])} ${String(args.atLeast)}=${JSON.stringify(record[String(args.atLeast)])}`
      }
    }
    if (left < right) {
      return {
        passed: false,
        output: `expected ${String(args.field)} >= ${String(args.atLeast)}, got ${left} < ${right}`
      }
    }
    return { passed: true, output: `${left} >= ${right}` }
  },

  /**
   * The text is a JSON object, with exactly these fields and types.
   *
   * `responseFormat` is a promise about the shape of the output, so the claim
   * is structural: it parses, it is an object rather than an array or a
   * scalar, each named field has the declared type, and -- when `exactKeys` is
   * set -- there is nothing else in it, which is what
   * `additionalProperties: false` means.
   */
  jsonObjectShape(value, args) {
    const text = String(value ?? '')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `not valid JSON: ${message}. Output: ${text.slice(0, 200)}` }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        passed: false,
        output: `expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
      }
    }
    const object = parsed as Record<string, unknown>

    for (const [field, kind] of Object.entries((args.fields ?? {}) as Record<string, string>)) {
      const measured = object[field]
      if (kind === 'string' && (typeof measured !== 'string' || measured.length === 0)) {
        return {
          passed: false,
          output: `${field} must be a non-empty string, got ${JSON.stringify(measured)}`
        }
      }
      if (kind === 'integer' && (typeof measured !== 'number' || !Number.isInteger(measured))) {
        return {
          passed: false,
          output: `${field} must be an integer, got ${JSON.stringify(measured)}`
        }
      }
      if (kind === 'number' && typeof measured !== 'number') {
        return {
          passed: false,
          output: `${field} must be a number, got ${JSON.stringify(measured)}`
        }
      }
    }

    if (args.exactKeys) {
      const actual = Object.keys(object).sort()
      const expected = [...(args.exactKeys as string[])].sort()
      if (actual.join(',') !== expected.join(',')) {
        return {
          passed: false,
          output: `additionalProperties:false violated. Expected exactly [${expected.join(',')}], got [${actual.join(',')}]`
        }
      }
    }
    return { passed: true, output: `object with keys [${Object.keys(object).join(',')}]` }
  },

  /**
   * The PNG has exactly these dimensions.
   *
   * What the per-test `validation: 'function'` closures were checking. Those
   * cannot cross to another client -- a function is not data -- so the numbers
   * travel in `with` and the reading happens here.
   */
  pngDimensions(value, args) {
    const bytes = asBytes(Array.isArray(value) ? value[0] : value)
    const dims = readPngDimensions(bytes)
    if (!dims) {
      return { passed: false, output: `not a valid PNG (${bytes.byteLength} bytes)` }
    }
    const [width, height] = [Number(args.width), Number(args.height)]
    if (dims.width !== width || dims.height !== height) {
      return {
        passed: false,
        output: `expected ${width}x${height}, got ${dims.width}x${dims.height}`
      }
    }
    return { passed: true, output: `${dims.width}x${dims.height}` }
  },

  /**
   * These fields are numbers, and none of them is negative.
   *
   * The phase timings a run reports: zero is a legitimate reading for a phase
   * that did no work, a negative one never is.
   */
  nonNegativeNumbers(value, args) {
    const record = (value ?? {}) as Record<string, unknown>
    for (const field of (args.fields ?? []) as string[]) {
      const measured = record[field]
      if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0) {
        return {
          passed: false,
          output: `${field} is not a non-negative number (got ${JSON.stringify(measured)})`
        }
      }
    }
    return { passed: true, output: `${(args.fields as string[]).length} field(s) non-negative` }
  },

  /**
   * The named fields add up to the total, within a tolerance.
   *
   * A diffusion run reports per-phase timings and one generation time; if they
   * do not reconcile, one of the phases is not being accounted for. The
   * tolerance is there because the total is integer-valued while the phases
   * keep fractional milliseconds.
   */
  fieldsSumTo(value, args) {
    const record = (value ?? {}) as Record<string, number>
    const fields = (args.fields ?? []) as string[]
    const total = fields.reduce((sum, field) => sum + Number(record[field] ?? 0), 0)
    const expected = Number(record[String(args.total)] ?? NaN)
    if (!Number.isFinite(expected)) {
      return { passed: false, output: `${String(args.total)} is missing from the record` }
    }
    const tolerance = Math.max(
      Number(args.minTolerance ?? 2),
      expected * Number(args.ratio ?? 0.01)
    )
    const delta = Math.abs(total - expected)
    if (delta > tolerance) {
      return {
        passed: false,
        output: `phases sum to ${total.toFixed(2)}, ${String(args.total)}=${expected}, delta ${delta.toFixed(2)}ms exceeds ${tolerance.toFixed(2)}ms`
      }
    }
    return { passed: true, output: `phases reconcile within ${delta.toFixed(2)}ms` }
  },

  /**
   * The collection has at least this many elements.
   *
   * The floor half of `lengthIs`: "the registry lists models" and "more than
   * one result came back" are the same check with a different bound, and a
   * test that pinned the exact count would fail whenever the registry grew.
   */
  lengthAtLeast(value, args) {
    if (!Array.isArray(value)) {
      return { passed: false, output: `expected an array, got ${typeof value}` }
    }
    const minimum = Number(args.length)
    if (value.length < minimum) {
      return { passed: false, output: `expected at least ${minimum}, got ${value.length}` }
    }
    return { passed: true, output: `${value.length} element(s)` }
  },

  /**
   * Named numbers sit inside the range.
   *
   * A probability is in [0,1] and a utilisation is in [0,1]; naming the bound
   * in the test rather than the registry keeps one check answering both.
   *
   * The value is a list of records, one record, or a bare number: an
   * embodiment's category id is a single number with a bound, and wrapping it
   * in a list to satisfy the assertion would be the test bending to the check.
   * `field` is what to read off a record and is not needed for a bare number;
   * `integer` additionally requires a whole number, which a category id is and
   * a probability is not.
   */
  numbersInRange(value, args) {
    const field = args.field === undefined ? undefined : String(args.field)
    const min = Number(args.min)
    const max = Number(args.max)
    const integer = args.integer === true
    const items: unknown[] = Array.isArray(value) ? value : [value]
    for (const item of items) {
      const measured =
        field === undefined ? item : (item as Record<string, unknown> | null)?.[field]
      const label = field ?? 'value'
      if (typeof measured !== 'number' || measured < min || measured > max) {
        return {
          passed: false,
          output: `${label} is outside [${min}, ${max}]: ${JSON.stringify(measured)}`
        }
      }
      if (integer && !Number.isInteger(measured)) {
        return { passed: false, output: `${label} is not an integer: ${measured}` }
      }
    }
    return { passed: true, output: `${items.length} value(s) within [${min}, ${max}]` }
  },

  /**
   * The value has no text in it.
   *
   * The empty-input tests: an empty prompt has nothing to translate, and the
   * claim is that the client says so rather than inventing output.
   */
  isEmptyText(value) {
    const text = typeof value === 'string' ? value : ''
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { passed: false, output: `expected a string, got ${typeof value}` }
    }
    return text.trim().length === 0
      ? { passed: true, output: '(empty)' }
      : { passed: false, output: `expected no text, got: ${text.slice(0, 120)}` }
  },

  /** The list is ordered by the named field, largest first. */
  sortedDescendingBy(value, args) {
    const items = (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>
    const field = String(args.field)
    for (let i = 1; i < items.length; i++) {
      const previous = Number(items[i - 1]?.[field] ?? 0)
      const current = Number(items[i]?.[field] ?? 0)
      if (current > previous) {
        return { passed: false, output: `not sorted by ${field} at index ${i}` }
      }
    }
    return { passed: true, output: `${items.length} element(s) in order` }
  },

  /**
   * The named field sums to a value, within a tolerance.
   *
   * Softmax probabilities sum to one; the tolerance is what keeps that a claim
   * about the model rather than about float accumulation order.
   */
  sumsTo(value, args) {
    const items = (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>
    const field = String(args.field)
    const total = items.reduce((sum, item) => sum + Number(item[field] ?? 0), 0)
    const expected = Number(args.total)
    const tolerance = Number(args.tolerance ?? 1e-3)
    if (Math.abs(total - expected) > tolerance) {
      return {
        passed: false,
        output: `${field} sums to ${total}, not within ${tolerance} of ${expected}`
      }
    }
    return { passed: true, output: `${field} sums to ${total}` }
  },

  /**
   * A `getSystemResources` record is well formed.
   *
   * Three claims the executor made inline, kept together because they are one
   * question about one record: every metric that reports `supported` says
   * where the number came from and none that does not report a value anyway;
   * a GPU is identified by an opaque id and never by the raw vendor/device
   * identifiers, which is a privacy boundary rather than a shape detail; and
   * a requested sample correlates with the capabilities it was taken against.
   *
   * `sample` says whether one was asked for -- a sample that arrives
   * unrequested is as much a failure as one that is missing.
   */
  systemResourcesShape(value, args) {
    const problems: string[] = []
    const record = (value ?? {}) as {
      capabilities?: Record<string, never>
      sample?: Record<string, never>
    }

    type Metric = { status?: string; value?: unknown; provenance?: { source?: string } }
    const metric = (m: unknown, label: string): Metric => {
      const measured = (m ?? {}) as Metric
      if (measured.status === 'supported') {
        if (!measured.provenance?.source) problems.push(`${label} has no provenance source`)
      } else if ('value' in measured) {
        problems.push(`${label} exposes a value with status ${String(measured.status)}`)
      }
      return measured
    }
    const utilization = (m: unknown, label: string) => {
      const measured = metric(m, label)
      const reading = measured.value as number
      if (measured.status === 'supported' && (reading < 0 || reading > 1)) {
        problems.push(`${label} is outside 0..1: ${reading}`)
      }
    }

    const capabilities = (record.capabilities ?? {}) as Record<string, never>
    if (!record.capabilities) problems.push('capabilities are missing')
    metric(capabilities['cpu'], 'capabilities.cpu')
    metric((capabilities['memory'] ?? {})['totalBytes'], 'capabilities.memory.totalBytes')
    const capabilityGpus = metric(capabilities['gpus'], 'capabilities.gpus')

    const RAW_IDENTITY = ['vendorId', 'deviceId', 'subsystemId', 'revision']
    let capabilityIds: string[] | undefined
    if (capabilityGpus.status === 'supported') {
      const gpus = (capabilityGpus.value ?? []) as Array<Record<string, unknown>>
      capabilityIds = gpus.map((gpu) => String(gpu['id']))
      for (const gpu of gpus) {
        if (!gpu['id']) problems.push('GPU has no opaque ID')
        for (const field of RAW_IDENTITY) {
          if (field in gpu) problems.push(`GPU exposes private identity field ${field}`)
        }
      }
    }

    if (!args.sample) {
      if (record.sample) problems.push('sample returned when it was not requested')
      return problems.length > 0
        ? { passed: false, output: problems.join('; ') }
        : { passed: true, output: 'capabilities valid; sample omitted' }
    }

    const sample = (record.sample ?? {}) as Record<string, never>
    if (!record.sample) {
      problems.push('requested sample is missing')
      return { passed: false, output: problems.join('; ') }
    }
    utilization(sample['cpu'], 'sample.cpu')
    const memory = (sample['memory'] ?? {}) as Record<string, never>
    metric(memory['usedBytes'], 'sample.memory.usedBytes')
    metric(memory['totalBytes'], 'sample.memory.totalBytes')
    metric(memory['processUsedBytes'], 'sample.memory.processUsedBytes')
    const allowance = metric(memory['processAvailableBytes'], 'sample.memory.processAvailableBytes')
    if (allowance.status === 'supported') {
      const reading = allowance.value as number
      if (reading <= 0) {
        problems.push(`sample.memory.processAvailableBytes is not positive: ${reading}`)
      }
      const scope = (allowance.provenance as { scope?: string } | undefined)?.scope
      if (scope !== 'process') {
        problems.push(`sample.memory.processAvailableBytes carries scope ${String(scope)}`)
      }
    } else if (args.platform === 'ios') {
      problems.push(`sample.memory.processAvailableBytes is ${String(allowance.status)} on iOS`)
    }

    const sampleGpus = metric(sample['gpus'], 'sample.gpus')
    if (capabilityIds && sampleGpus.status === 'supported') {
      const gpus = (sampleGpus.value ?? []) as Array<Record<string, unknown>>
      if (capabilityIds.join(',') !== gpus.map((gpu) => String(gpu['id'])).join(',')) {
        problems.push('capability and sample GPU IDs do not correlate')
      }
      for (const gpu of gpus) {
        utilization(gpu['compute'], `sample.gpus.${String(gpu['id'])}.compute`)
        utilization(gpu['encode'], `sample.gpus.${String(gpu['id'])}.encode`)
        utilization(gpu['decode'], `sample.gpus.${String(gpu['id'])}.decode`)
      }
    }

    return problems.length > 0
      ? { passed: false, output: problems.join('; ') }
      : { passed: true, output: 'capabilities valid; sample valid' }
  },

  /**
   * Each named result's text carries what that result was asked for.
   *
   * A batch answers several prompts at once, so "the output contains both
   * markers" is not the question -- either prompt could have produced both.
   * `mode: 'any'` is the looser form a vision prompt needs, where several
   * words would each be a right answer.
   */
  textsById(value, args) {
    const results = (Array.isArray(value) ? value : []) as Array<{
      id?: string
      final?: { contentText?: string }
    }>
    const byId = new Map(results.map((result) => [result.id, result.final?.contentText ?? '']))
    const expected = (args.expect ?? {}) as Record<string, string[]>
    const any = args.mode === 'any'

    for (const [id, terms] of Object.entries(expected)) {
      const text = byId.get(id)
      if (text === undefined) {
        return { passed: false, output: `no result for id "${id}": got ${[...byId.keys()]}` }
      }
      const lower = text.toLowerCase()
      const hits = terms.filter((term) => lower.includes(term.toLowerCase()))
      if (any ? hits.length === 0 : hits.length !== terms.length) {
        const missing = terms.filter((term) => !hits.includes(term))
        return {
          passed: false,
          output: `"${id}" is missing ${any ? 'any of' : ''} ${JSON.stringify(missing)}: ${text.slice(0, 160)}`
        }
      }
    }
    return { passed: true, output: `${Object.keys(expected).length} id(s) matched` }
  },

  /**
   * Every named result was streamed, not just delivered.
   *
   * The batch's final results look the same whether the text arrived in one
   * frame or in fifty, so a streaming test that only read the finals would
   * pass with streaming switched off.
   */
  streamedEachId(value, args) {
    const events = (Array.isArray(value) ? value : []) as Array<{
      id?: string
      event?: { type?: string; text?: string }
    }>
    const counts = new Map<string, number>()
    for (const { id, event } of events) {
      if (id === undefined) continue
      if (event?.type === 'contentDelta' && (event.text ?? '').length > 0) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    const missing = ((args.ids ?? []) as string[]).filter((id) => (counts.get(id) ?? 0) === 0)
    if (missing.length > 0) {
      return { passed: false, output: `no streamed content for: ${missing.join(', ')}` }
    }
    return { passed: true, output: `streamed ${[...counts.values()].join('/')} delta(s)` }
  },

  /**
   * These results made no tool call.
   *
   * The other half of `toolCallShape`: a batch where one prompt declares a
   * tool and another does not is only answered if the second one stayed quiet.
   */
  noToolCallsFor(value, args) {
    const results = (Array.isArray(value) ? value : []) as Array<{
      id?: string
      final?: { toolCalls?: Array<{ name?: string }> }
    }>
    for (const id of (args.ids ?? []) as string[]) {
      const calls = results.find((result) => result.id === id)?.final?.toolCalls ?? []
      if (calls.length > 0) {
        return {
          passed: false,
          output: `"${id}" was expected to make no tool call, made: ${calls.map((c) => c.name).join(', ')}`
        }
      }
    }
    return { passed: true, output: `${(args.ids as string[]).length} id(s) stayed quiet` }
  },

  /**
   * Every named field is present on the value.
   *
   * Replaces the inline "which required fields are missing" loops that several
   * executors grew independently. Generic on purpose: the field list belongs to
   * the test, not to the assertion registry.
   */
  fieldsPresent(value, args) {
    if (!value || typeof value !== 'object') {
      return { passed: false, output: `expected an object, got ${typeof value}` }
    }
    const record = value as Record<string, unknown>
    const fields = (args.fields ?? []) as string[]
    const missing = fields.filter((field) => record[field] === undefined)
    if (missing.length > 0) {
      return { passed: false, output: `missing fields: ${missing.join(', ')}` }
    }
    return { passed: true, output: `${fields.length} field(s) present` }
  },

  /**
   * The text is exactly the parts joined by the separator.
   *
   * A batch translation returns both the entries and one text, and the claim
   * is that they are the same answer in two shapes rather than two answers.
   */
  equalsJoined(value, args) {
    const parts = ((args.parts ?? []) as unknown[]).map(String)
    const expected = parts.join(String(args.separator ?? '\n'))
    if (value !== expected) {
      return {
        passed: false,
        output: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`
      }
    }
    return { passed: true, output: `${parts.length} part(s) joined` }
  },

  /**
   * The load was a cache hit: nothing was downloaded again.
   *
   * A real download reports many partial-percentage events per file; a cache
   * hit reports at most a final one. Counting the partials is what makes "the
   * cache held" observable from outside, since neither client can see the
   * cache directory the way the engine does.
   */
  noPartialDownloads(value) {
    const events = (Array.isArray(value) ? value : []) as Array<{
      total?: number
      downloaded?: number
      percentage?: number
      downloadKey?: string
    }>
    const partials = events.filter(
      (event) => (event.total ?? 0) > 0 && (event.downloaded ?? 0) < (event.total ?? 0)
    )
    if (partials.length > 0) {
      const keys = new Set(partials.map((event) => String(event.downloadKey)))
      const sample = partials
        .slice(0, 3)
        .map((event) => `${String(event.downloadKey)}@${Number(event.percentage ?? 0).toFixed(0)}%`)
        .join(', ')
      return {
        passed: false,
        output: `re-downloaded ${keys.size} file(s), ${partials.length} partial event(s). First: ${sample}`
      }
    }
    return { passed: true, output: `${events.length} cache-hit notification(s)` }
  },

  /**
   * Transcript segments are well formed and in audio-time order.
   *
   * Every field the consumer of a metadata transcription reads, plus the
   * ordering invariant: segments are emitted in audio time, and ids only go
   * forward. Out-of-order segments would reassemble into the wrong transcript
   * without any single segment looking wrong.
   *
   * `flags` names extra boolean fields every segment must carry: parakeet adds
   * `isEndOfTurn` / `startsWord`, whisper does not, and the difference is the
   * whole point of the parakeet metadata test.
   */
  transcriptSegmentsShape(value, args) {
    const { flags = [] } = (args ?? {}) as { flags?: string[] }
    const segments = value as Array<Record<string, unknown>>
    if (!Array.isArray(segments)) {
      return { passed: false, output: `expected an array, got ${typeof value}` }
    }
    if (segments.length === 0) {
      return { passed: false, output: 'expected at least one segment' }
    }

    let previousStart = -Infinity
    let previousId = -Infinity
    for (const [index, segment] of segments.entries()) {
      if (typeof segment !== 'object' || segment === null) {
        return { passed: false, output: `segment ${index}: not an object` }
      }
      const startMs = segment['startMs']
      const endMs = segment['endMs']
      if (typeof segment['text'] !== 'string') {
        return { passed: false, output: `segment ${index}: missing/invalid text` }
      }
      if (typeof startMs !== 'number' || !Number.isFinite(startMs)) {
        return { passed: false, output: `segment ${index}: missing/invalid startMs` }
      }
      if (typeof endMs !== 'number' || !Number.isFinite(endMs)) {
        return { passed: false, output: `segment ${index}: missing/invalid endMs` }
      }
      if (endMs < startMs) {
        return { passed: false, output: `segment ${index}: endMs ${endMs} < startMs ${startMs}` }
      }
      if (typeof segment['append'] !== 'boolean') {
        return { passed: false, output: `segment ${index}: missing/invalid append` }
      }
      const id = segment['id']
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        return { passed: false, output: `segment ${index}: missing/invalid id` }
      }
      for (const flag of flags) {
        if (typeof segment[flag] !== 'boolean') {
          return { passed: false, output: `segment ${index}: missing/invalid ${flag}` }
        }
      }
      if (startMs < previousStart) {
        return {
          passed: false,
          output: `segment ${index}: out-of-order startMs ${startMs} < ${previousStart}`
        }
      }
      if (id < previousId) {
        return { passed: false, output: `segment ${index}: out-of-order id ${id} < ${previousId}` }
      }
      previousStart = startMs
      previousId = id
    }
    const carried = flags.length > 0 ? `, all carrying ${flags.join(' / ')}` : ''
    return { passed: true, output: `${segments.length} segment(s) in order${carried}` }
  },

  /**
   * The event stream carries the types this test expects, and not the ones it
   * forbids.
   *
   * Counting by type is what all of these tests were doing by hand. `absent`
   * matters as much as `atLeast`: parakeet must not emit standalone `vad`
   * events, and a check that only looked for what it wanted would pass on a
   * client that emitted everything.
   */
  eventTypeCounts(value, args) {
    const events = (Array.isArray(value) ? value : []) as Array<{ type?: string }>
    const counts: Record<string, number> = {}
    for (const event of events) {
      const type = String(event.type ?? 'unknown')
      counts[type] = (counts[type] ?? 0) + 1
    }
    const summary = JSON.stringify(counts)

    for (const [type, minimum] of Object.entries((args.atLeast ?? {}) as Record<string, number>)) {
      if ((counts[type] ?? 0) < minimum) {
        return {
          passed: false,
          output: `expected at least ${minimum} ${type} event(s), got ${summary}`
        }
      }
    }
    for (const type of (args.absent ?? []) as string[]) {
      if (counts[type]) {
        return {
          passed: false,
          output: `${type} event(s) were emitted but must not be: ${summary}`
        }
      }
    }
    return { passed: true, output: summary }
  },

  /**
   * Every event of this type carries the fields it should, and none of the
   * fields belonging to the other half of the union.
   *
   * Parakeet's end-of-turn is token-driven and must declare
   * `source: "parakeet"` without a `silenceDurationMs`; that field is the
   * whisper variant, and a client that filled in both would be reporting a
   * shape no consumer can discriminate on.
   */
  eventShape(value, args) {
    const events = (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>
    const type = String(args.type)
    const equals = (args.equals ?? {}) as Record<string, unknown>
    const absent = (args.absent ?? []) as string[]

    for (const event of events) {
      if (event.type !== type) continue
      for (const [field, expected] of Object.entries(equals)) {
        if (event[field] !== expected) {
          return {
            passed: false,
            output: `${type} event has ${field}=${JSON.stringify(event[field])}, expected ${JSON.stringify(expected)}: ${JSON.stringify(event)}`
          }
        }
      }
      for (const field of absent) {
        if (event[field] !== undefined) {
          return {
            passed: false,
            output: `${type} event must omit ${field}: ${JSON.stringify(event)}`
          }
        }
      }
    }
    return { passed: true, output: `${type} events well formed` }
  },

  /**
   * The text contains every one of these terms.
   *
   * The same shape as a `contains-all` expectation, available as a named
   * assertion so a body can ask it of something other than the one value the
   * expectation is about -- a rejection's message alongside its code, say.
   */
  containsAll(value, args) {
    const text = String(value ?? '').toLowerCase()
    const terms = (args.terms ?? []) as string[]
    const missing = terms.filter((term) => !text.includes(term.toLowerCase()))
    if (missing.length > 0) {
      return {
        passed: false,
        output: `missing ${JSON.stringify(missing)} in: ${String(value).slice(0, 200)}`
      }
    }
    return { passed: true, output: `${terms.length} term(s) present` }
  },

  /** The text contains at least one of these terms. */
  containsAny(value, args) {
    const text = String(value ?? '').toLowerCase()
    const terms = (args.terms ?? []) as string[]
    if (!terms.some((term) => text.includes(term.toLowerCase()))) {
      return {
        passed: false,
        output: `none of ${JSON.stringify(terms)} in: ${String(value).slice(0, 200)}`
      }
    }
    return { passed: true, output: 'matched' }
  },

  /**
   * At least one of the named fields is present.
   *
   * For the readings an engine may report in more than one shape: which timing
   * field a backend fills is its business, that it reported timing at all is
   * the claim.
   */
  anyFieldPresent(value, args) {
    const record = (value ?? {}) as Record<string, unknown>
    const fields = (args.fields ?? []) as string[]
    const found = fields.filter((field) => record[field] !== undefined)
    if (found.length === 0) {
      return { passed: false, output: `none of ${fields.join(', ')} are present` }
    }
    return { passed: true, output: `${found.join(', ')} present` }
  },

  /**
   * Two records agree on the named fields.
   *
   * Compared as strings so a client that returns a number where another
   * returns a numeric string is not reported as drift -- the question here is
   * whether two views of the same record agree, not how each typed it.
   */
  fieldsMatch(value, args) {
    const left = (value ?? {}) as Record<string, unknown>
    const right = (args.expected ?? {}) as Record<string, unknown>
    const fields = (args.fields ?? []) as string[]
    const mismatched = fields.filter((field) => String(left[field]) !== String(right[field]))
    if (mismatched.length > 0) {
      return {
        passed: false,
        output: mismatched
          .map((field) => `${field}: ${String(left[field])} != ${String(right[field])}`)
          .join('; ')
      }
    }
    return { passed: true, output: `${fields.length} field(s) match` }
  },

  /**
   * The rejection carried machine-readable structure, not just a string.
   *
   * A chained cause or a present error code both answer that; which one a
   * given SDK surfaces is an implementation choice, and pinning the test to
   * one of them would make it a test of that choice rather than of the
   * guarantee.
   */
  errorIsStructured(value) {
    const err = (value ?? {}) as { code?: string; hasCause?: boolean; message?: string }
    const hasCode = typeof err.code === 'string' && err.code.length > 0
    if (!hasCode && !err.hasCause) {
      return {
        passed: false,
        output: `rejection carried neither a code nor a cause: ${err.message ?? '(no message)'}`
      }
    }
    return {
      passed: true,
      output: `hasCause=${Boolean(err.hasCause)}, code=${err.code || '(none)'}`
    }
  },

  /**
   * The value is a string with something in it.
   *
   * `expectedType: 'string'` only asks about the type, and `minLength` in the
   * expectation applies to arrays, so "it produced text" had no way to be said
   * until now. Every generative category needs it.
   */
  nonEmptyText(value) {
    if (typeof value !== 'string') {
      return { passed: false, output: `expected a string, got ${typeof value}` }
    }
    if (value.trim().length === 0) {
      return { passed: false, output: 'expected text, got an empty string' }
    }
    return { passed: true, output: `${value.length} character(s)` }
  },

  /**
   * The rejection is the one the test meant, by code and by wording.
   *
   * `messageNotMatching` is the half that is easy to forget and the reason
   * this is not just a `contains`: several error tests exist to prove a bad
   * argument is rejected *by the SDK* rather than forwarded to the addon, and
   * only the wording of the failure tells those two apart.
   */
  errorMatches(value, args) {
    const err = (value ?? {}) as { code?: string; message?: string }
    const message = err.message ?? ''

    if (args.code !== undefined && String(err.code) !== String(args.code)) {
      return { passed: false, output: `expected code ${String(args.code)}, got ${err.code}` }
    }
    if (
      args.messageContains !== undefined &&
      !message.toLowerCase().includes(String(args.messageContains).toLowerCase())
    ) {
      return {
        passed: false,
        output: `message does not contain "${String(args.messageContains)}": ${message}`
      }
    }
    if (
      args.messageNotMatching !== undefined &&
      new RegExp(String(args.messageNotMatching), 'i').test(message)
    ) {
      return { passed: false, output: `message matched the forbidden pattern: ${message}` }
    }
    return { passed: true, output: `code=${err.code || '(none)'}: ${message.slice(0, 120)}` }
  },

  /**
   * The model made a structured tool call, and the right one.
   *
   * `declared` is the tools the test offered: a call naming something that was
   * never declared is a failure however well-formed it looks, and that check
   * is the reason this is not an ordinary field comparison.
   */
  toolCallShape(value, args) {
    const calls = (Array.isArray(value) ? value : []) as Array<{
      name?: string
      arguments?: Record<string, unknown>
    }>
    if (calls.length === 0) {
      return { passed: false, output: 'expected a structured tool call but the model made none' }
    }

    const declared = new Set((args.declared ?? []) as string[])
    const valid = calls.filter((call) => typeof call.name === 'string' && declared.has(call.name))
    if (valid.length === 0) {
      return {
        passed: false,
        output:
          `no tool call matched a declared tool. Got: [${calls.map((c) => c.name ?? '<unnamed>').join(', ')}], ` +
          `declared: [${[...declared].join(', ')}]`
      }
    }

    const match = valid.find((call) => call.name === args.name)
    if (match) {
      const callArgs = match.arguments ?? {}
      for (const key of (args.argKeys ?? []) as string[]) {
        if (!(key in callArgs)) {
          return {
            passed: false,
            output: `tool call '${String(args.name)}' is missing argument '${key}': ${JSON.stringify(callArgs)}`
          }
        }
      }
    }

    return { passed: true, output: `tool call(s): ${valid.map((call) => call.name).join(', ')}` }
  },

  /**
   * Every block carries the geometry a caller needs to place it.
   *
   * The OCR executors checked this inline; as a named assertion it is the same
   * check on every client, which is the difference between two clients
   * agreeing and two clients each having an opinion.
   */
  textBlockShape(value) {
    const blocks = (Array.isArray(value) ? value : []) as Array<{
      text?: unknown
      bbox?: unknown
      confidence?: unknown
    }>
    for (const [index, block] of blocks.entries()) {
      if (typeof block.text !== 'string') {
        return { passed: false, output: `block[${index}].text is not a string` }
      }
      const bbox = block.bbox
      if (!Array.isArray(bbox) || bbox.length !== 4) {
        return { passed: false, output: `block[${index}].bbox is not a 4-element array` }
      }
      const bad = bbox.findIndex((coordinate) => typeof coordinate !== 'number')
      if (bad !== -1) {
        return { passed: false, output: `block[${index}].bbox[${bad}] is not a number` }
      }
      if (typeof block.confidence !== 'number') {
        return { passed: false, output: `block[${index}].confidence is not a number` }
      }
    }
    return { passed: true, output: `${blocks.length} well-formed block(s)` }
  },

  /**
   * The run reported how long it took.
   *
   * `field` names which timing to insist on, because the engines do not agree
   * on what they measure -- and a test that only checks "stats exist" passes
   * on an object full of nulls.
   */
  timingStatsPresent(value, args) {
    if (!value || typeof value !== 'object') {
      return { passed: false, output: 'stats is undefined, expected timing data' }
    }
    const stats = value as Record<string, unknown>
    const field = String(args.field ?? 'totalTime')
    const measured = stats[field]
    if (typeof measured !== 'number' || measured <= 0) {
      return {
        passed: false,
        output: `expected stats.${field} > 0, got ${JSON.stringify(measured)}`
      }
    }
    return { passed: true, output: `${field}=${measured}` }
  },

  /**
   * The run produced audio.
   *
   * `minSamples` is the bar: 1 for a normal synthesis, 0 for the tests that
   * feed empty text and only care that the SDK handled it rather than
   * crashing. The executors asserted a synthesised sentence -- "generated N
   * samples" -- against `type: string`, which every string satisfies, so they
   * could not fail whatever the engine did. This asks the question they meant.
   */
  producedAudio(value, args) {
    const samples = Array.isArray(value)
      ? value.length
      : ArrayBuffer.isView(value)
        ? (value as unknown as { length: number }).length
        : 0
    const floor = Number(args.minSamples ?? 1)
    if (samples < floor) {
      return { passed: false, output: `expected at least ${floor} sample(s), got ${samples}` }
    }
    return { passed: true, output: `${samples} sample(s)` }
  },

  /**
   * The value is exactly `true`.
   *
   * For the operations whose whole answer is "it worked": the executors turned
   * that into the string "success" and matched it against `type: string`,
   * which is satisfied by "failed" just as well.
   */
  isTrue(value) {
    if (value !== true) {
      return { passed: false, output: `expected true, got ${JSON.stringify(value)}` }
    }
    return { passed: true, output: 'true' }
  },

  /**
   * Every named field is a positive integer.
   *
   * Model hyper-parameters are the recurring case: a chunk size or an action
   * dimension that arrives as 0, a float, or a string is a broken model
   * description however well-formed the surrounding object looks.
   */
  positiveIntegers(value, args) {
    const record = (value ?? {}) as Record<string, unknown>
    for (const field of (args.fields ?? []) as string[]) {
      const measured = record[field]
      if (typeof measured !== 'number' || !Number.isInteger(measured) || measured <= 0) {
        return {
          passed: false,
          output: `${field} is not a positive integer (got ${JSON.stringify(measured)})`
        }
      }
    }
    return { passed: true, output: `${(args.fields as string[]).length} field(s) positive` }
  },

  /** The value is one of a known set. `allowNull` admits "not reported". */
  valueIn(value, args) {
    if (value === null && args.allowNull) return { passed: true, output: 'null' }
    const allowed = (args.values ?? []) as unknown[]
    if (!allowed.includes(value)) {
      return {
        passed: false,
        output: `${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`
      }
    }
    return { passed: true, output: String(value) }
  },

  /**
   * Two fields of the same object agree.
   *
   * For the invariants a result carries about itself -- a buffer whose length
   * must equal the product of the dimensions reported beside it.
   */
  fieldEquals(value, args) {
    const record = (value ?? {}) as Record<string, unknown>
    const left = record[String(args.field)]
    const right = record[String(args.other)]
    if (left !== right) {
      return {
        passed: false,
        output: `${String(args.field)}=${JSON.stringify(left)} != ${String(args.other)}=${JSON.stringify(right)}`
      }
    }
    return { passed: true, output: `${String(args.field)} == ${String(args.other)}` }
  },

  loadedModelInfoShape(value, args) {
    const info = value as {
      modelId?: string
      modelType?: string
      handlers?: string[]
    }

    const checks: Record<string, boolean> = {
      modelIdMatches: info.modelId === args.expectedModelId,
      handlersIsList: Array.isArray(info.handlers),
      modelTypePresent: typeof info.modelType === 'string' && info.modelType.length > 0
    }
    if (args.handlerIncludes !== undefined) {
      checks.handlerPresent = (info.handlers ?? []).includes(args.handlerIncludes as string)
    }

    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)

    if (failed.length > 0) {
      return {
        passed: false,
        output:
          `loadedModelInfoShape failed: ${failed.join(', ')} ` +
          `(modelId=${info.modelId}, modelType=${info.modelType}, handlers=${JSON.stringify(info.handlers)})`
      }
    }

    return {
      passed: true,
      output: `modelType=${info.modelType}, handlers=${info.handlers?.length ?? 0}`
    }
  }
}

export function createStepBindings(resources: ResourceManager): StepBindings {
  return {
    async useModel(deps) {
      const ids: string[] = []
      for (const dep of deps) {
        ids.push(await resources.ensureLoaded(dep))
      }
      return ids
    },

    async call(method, params, collect) {
      /**
       * Unloads one resource and forgets it, through the resource manager.
       *
       * Not an SDK method, and deliberately not in the tables below: a reload
       * test has to put the model back where the manager can find it, and
       * unloading the id directly would leave the manager handing out an id
       * the worker no longer knows. The manager is only in scope here.
       */
      if (method === 'evictResource') {
        await resources.evict(String((params as { dep: string }).dep))
        return { evicted: true }
      }
      /**
       * A fresh directory the test may write into, and a look at what landed
       * there.
       *
       * Platform facts, not SDK calls, which is why they live beside
       * `asset` rather than in the method tables. They are deliberately
       * narrow: the directory is one this client just made, and the only
       * question asked of it is whether a file the API was told to produce is
       * there. That is a claim about the public contract -- unlike reading
       * the engine's own storage layout, which would let a test assert
       * anything about anywhere.
       */
      if (method === 'scratchDirectory') {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-e2e-'))
        const names = ((params as { subdirectories?: string[] }).subdirectories ?? []) as string[]
        const directories: Record<string, string> = {}
        for (const name of names) {
          const made = path.join(root, name)
          directories[name] = made
          fs.mkdirSync(made, { recursive: true })
        }
        scratchDirectories.add(root)
        // The subdirectory paths are handed back rather than joined in the
        // catalog: a step names data, and building a path out of two bound
        // values is not something it can do.
        return { path: root, directories }
      }
      if (method === 'producedFile') {
        const p = params as { directory: string; file: string }
        if (!withinScratch(p.directory)) {
          throw new Error(`"${p.directory}" is not inside a directory this test created`)
        }
        const target = path.join(p.directory, p.file)
        return { exists: fs.existsSync(target), path: target }
      }
      if (method === 'discardScratchDirectory') {
        const target = (params as { path?: string }).path
        if (!target || !scratchDirectories.has(target)) return { discarded: false }
        scratchDirectories.delete(target)
        fs.rmSync(target, { recursive: true, force: true })
        return { discarded: true }
      }
      if (collect) {
        const stream = STREAMS[method]
        if (!stream) {
          // A gap in the bindings, not a failing test, so say so explicitly —
          // a plain Error would be reported as a failure.
          throw new StepIncompleteError(
            `SDK method "${method}" has no stream fold in these bindings yet`
          )
        }
        return stream(params as never, collect)
      }

      const call = CALLS[method]
      if (!call) {
        throw new StepIncompleteError(`SDK method "${method}" is not wired into these bindings yet`)
      }
      return call(params as never)
    },

    async modelSource(dep) {
      return resources.sourceOf(dep)
    },

    async asset(kind, file, form) {
      if (kind === 'bytes') {
        if (form === 'path') throw new Error('synthesized bytes have no path')
        return synthesizeBytes(file)
      }
      if (kind === 'tone') {
        if (form === 'path') throw new Error('a synthesized tone has no path')
        return synthesizeTone(file)
      }
      const root = ASSET_ROOTS[kind]
      if (!root) {
        throw new StepIncompleteError(`asset kind "${kind}" is not known to these bindings`)
      }
      const base = path.resolve(process.cwd(), root)
      const absolute = path.resolve(base, file)
      // The asset name arrives from the catalog, and a definition is data that
      // travels between clients. A name that climbs out of the asset root must
      // be refused here rather than trusted because today's catalog happens to
      // contain only literals.
      if (absolute !== base && !absolute.startsWith(base + path.sep)) {
        throw new Error(`asset "${file}" resolves outside the "${kind}" asset root`)
      }
      if (!fs.existsSync(absolute)) {
        // A missing fixture is a real failure, not a client gap.
        throw new Error(`asset not found: ${absolute}`)
      }
      // On desktop the path form is a filesystem path; a mobile binding hands
      // back a bundled-asset URI for the same pair, which is the entire reason
      // several categories still carry two executors.
      if (form === 'path') return absolute
      if (form === 'text') return fs.readFileSync(absolute, 'utf-8')
      return new Uint8Array(fs.readFileSync(absolute))
    },

    assertions: ASSERTIONS,

    comparisons: COMPARISONS,

    async evictAllExcept(keep) {
      await resources.evictExcept([...keep])
    }
  }
}
