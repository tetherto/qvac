'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const os = require('bare-os')
const GGMLBert = require('../../index')
const { generateDocument, chunkDocument, getDocumentStats } = require('./generate-document')

const MODELS = {
  gte: {
    url: 'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large.Q8_0.gguf',
    filename: 'gte-large.Q8_0.gguf',
    label: 'GTE-Large (Q8_0)'
  },
  gemma: {
    url: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf',
    filename: 'embeddinggemma-300M-Q8_0.gguf',
    label: 'EmbeddingGemma-300M (Q8_0)'
  }
}

const CHUNK_CONFIGS = [
  { label: 'small (64w, 10w overlap)', chunkSize: 64, overlap: 10 },
  { label: 'medium (128w, 20w overlap)', chunkSize: 128, overlap: 20 },
  { label: 'large (256w, 40w overlap)', chunkSize: 256, overlap: 40 }
]

const MULTIPLIERS = [1, 5, 10]
const WARMUP_RUNS = 2
const BENCH_REPEATS = 3

function parseArgs (argv) {
  const parsed = {}
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      i++
    }
  }
  return parsed
}

async function downloadFile (url, dest) {
  const https = require('bare-https')
  return new Promise((resolve, reject) => {
    let resolved = false
    const safeResolve = () => { if (!resolved) { resolved = true; resolve() } }
    const safeReject = (err) => { if (!resolved) { resolved = true; reject(err) } }

    const file = fs.createWriteStream(dest)
    file.on('error', (err) => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })

    const req = https.request(url, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        file.destroy()
        fs.unlink(dest, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') return safeReject(unlinkErr)
          const redirectUrl = new URL(response.headers.location, url).href
          downloadFile(redirectUrl, dest).then(safeResolve).catch(safeReject)
        })
        return
      }
      if (response.statusCode !== 200) {
        file.destroy()
        fs.unlink(dest, () => safeReject(new Error('Download failed: ' + response.statusCode)))
        return
      }

      const total = parseInt(response.headers['content-length'], 10)
      let downloaded = 0
      response.on('data', (chunk) => {
        downloaded += chunk.length
        if (total) {
          const pct = ((downloaded / total) * 100).toFixed(1)
          const dlMB = (downloaded / 1024 / 1024).toFixed(1)
          const totMB = (total / 1024 / 1024).toFixed(1)
          process.stdout.write('\r  ' + pct + '% (' + dlMB + '/' + totMB + 'MB)')
        }
      })
      response.on('error', (err) => {
        file.destroy()
        fs.unlink(dest, () => safeReject(err))
      })
      response.pipe(file)
      file.on('close', () => {
        console.log('')
        safeResolve()
      })
    })
    req.on('error', (err) => {
      file.destroy()
      fs.unlink(dest, () => safeReject(err))
    })
    req.end()
  })
}

async function ensureModel (modelConfig) {
  const modelDir = path.resolve(__dirname, '../../test/model')
  const modelPath = path.join(modelDir, modelConfig.filename)

  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath)
    console.log('Model found: ' + modelConfig.filename + ' (' + (stats.size / 1024 / 1024).toFixed(1) + 'MB)')
    return modelPath
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log('Downloading model: ' + modelConfig.filename + '...')
  await downloadFile(modelConfig.url, modelPath)
  console.log('Download complete.')
  return modelPath
}

function silentLogger () {
  return { error () {}, warn () {}, info () {}, debug () {} }
}

async function loadModel (modelPath, device, batchSize, splitMode, tensorSplit) {
  const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
  if (isDarwinX64) device = 'cpu'

  const config = {
    device,
    gpu_layers: device === 'cpu' ? '0' : '999',
    batch_size: String(batchSize)
  }

  if (splitMode && splitMode !== 'none') {
    config['split-mode'] = splitMode
  }
  if (tensorSplit) {
    config['tensor-split'] = tensorSplit
  }

  if (os.platform() === 'android') {
    config.flash_attn = 'off'
  }

  const model = new GGMLBert({
    files: { model: [modelPath] },
    config,
    logger: silentLogger(),
    opts: { stats: true }
  })

  const loadStart = process.hrtime()
  await model.load()
  const loadElapsed = hrtimeMs(loadStart)

  return { model, loadMs: loadElapsed, device }
}

function hrtimeMs (start) {
  const diff = process.hrtime(start)
  return diff[0] * 1000 + diff[1] / 1e6
}

async function embedChunks (model, chunks) {
  const response = await model.run(chunks)
  const rawEmbeddings = await response.await()
  const stats = response.stats || {}
  return { rawEmbeddings, stats }
}

async function benchmarkChunkConfig (model, chunks, configLabel) {
  console.log('\n  Chunk config: ' + configLabel)
  console.log('  Chunks to embed: ' + chunks.length)

  for (let i = 0; i < WARMUP_RUNS; i++) {
    await embedChunks(model, chunks)
  }

  const timings = []
  const tpsValues = []
  let lastEmbeddings = null
  let backendDevice = null

  for (let i = 0; i < BENCH_REPEATS; i++) {
    const runStart = process.hrtime()
    const { rawEmbeddings, stats } = await embedChunks(model, chunks)
    const runMs = hrtimeMs(runStart)
    timings.push(runMs)
    lastEmbeddings = rawEmbeddings
    if (stats.tokens_per_second) tpsValues.push(stats.tokens_per_second)
    if (stats.backendDevice) backendDevice = stats.backendDevice
  }

  const embeddingCount = lastEmbeddings[0] ? lastEmbeddings[0].length : 0
  const embeddingDim = embeddingCount > 0 ? lastEmbeddings[0][0].length : 0

  const avgMs = timings.reduce((a, b) => a + b, 0) / timings.length
  const minMs = Math.min(...timings)
  const maxMs = Math.max(...timings)
  const avgTps = tpsValues.length > 0
    ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length
    : null

  const chunksPerSec = (chunks.length / (avgMs / 1000))

  return {
    configLabel,
    numChunks: chunks.length,
    embeddingCount,
    embeddingDim,
    avgMs: round(avgMs),
    minMs: round(minMs),
    maxMs: round(maxMs),
    avgTps: avgTps ? round(avgTps) : null,
    chunksPerSec: round(chunksPerSec),
    timings: timings.map(round),
    backendDevice
  }
}

function round (val, decimals) {
  if (decimals == null) decimals = 2
  const factor = Math.pow(10, decimals)
  return Math.round(val * factor) / factor
}

function padRight (str, len) {
  if (str.length >= len) return str
  return str + ' '.repeat(len - str.length)
}

async function benchmarkModel (modelKey, modelConfig, device, batchSize, splitMode, tensorSplit) {
  console.log('\n' + '#'.repeat(72))
  console.log('# MODEL: ' + modelConfig.label)
  console.log('#'.repeat(72))

  const modelPath = await ensureModel(modelConfig)

  const splitLabel = splitMode !== 'none' ? ', split-mode=' + splitMode : ''
  const tensorLabel = tensorSplit ? ', tensor-split=' + tensorSplit : ''
  console.log('\nLoading model (device=' + device + ', batch_size=' + batchSize + splitLabel + tensorLabel + ')...')
  const { model, loadMs, device: resolvedDevice } = await loadModel(modelPath, device, batchSize, splitMode, tensorSplit)
  console.log('Model loaded in ' + round(loadMs) + 'ms')

  const baseDocument = generateDocument()
  const scaleResults = []

  try {
    for (const multiplier of MULTIPLIERS) {
      const scaleLabel = multiplier + 'x'
      console.log('\n' + '='.repeat(60))
      console.log('  Scale: ' + scaleLabel + (multiplier > 1 ? ' (' + multiplier + ' x base document)' : ' (base document)'))
      console.log('='.repeat(60))

      const document = multiplier > 1
        ? Array(multiplier).fill(baseDocument).join('\n\n')
        : baseDocument
      const docStats = getDocumentStats(document)
      console.log('  Words: ' + docStats.words + ', ~' + docStats.pages + ' pages')

      const chunkResults = []
      for (const cfg of CHUNK_CONFIGS) {
        const chunks = chunkDocument(document, cfg.chunkSize, cfg.overlap)
        const result = await benchmarkChunkConfig(model, chunks, cfg.label)
        chunkResults.push(result)
      }

      scaleResults.push({
        multiplier,
        scaleLabel,
        docStats,
        results: chunkResults
      })

      printScaleResults(docStats, chunkResults, scaleLabel)
    }
  } finally {
    console.log('\nUnloading model: ' + modelConfig.label + '...')
    await model.unload()
    console.log('Done.')
  }

  const runtimeDevice = scaleResults[0]?.results[0]?.backendDevice

  return {
    modelKey,
    label: modelConfig.label,
    filename: modelConfig.filename,
    loadMs: round(loadMs),
    device: runtimeDevice || resolvedDevice,
    scaleResults
  }
}

function printScaleResults (docStats, results, scaleLabel) {
  console.log('\n  --- ' + scaleLabel + ' Results ---')
  console.log('  ' + padRight('Chunk Config', 30) + padRight('Chunks', 8) + padRight('Avg(ms)', 10) + padRight('TPS', 10) + 'Chunks/s')
  console.log('  ' + '-'.repeat(68))
  for (const r of results) {
    console.log('  ' +
      padRight(r.configLabel, 30) +
      padRight(String(r.numChunks), 8) +
      padRight(String(r.avgMs), 10) +
      padRight(r.avgTps != null ? String(r.avgTps) : 'n/a', 10) +
      String(r.chunksPerSec)
    )
  }
}

function generateReport (allModelResults, meta) {
  const W = 80
  const lines = []

  function hr (ch) { lines.push(ch.repeat(W)) }
  function blank () { lines.push('') }
  function heading (text) {
    blank()
    hr('=')
    lines.push(text)
    hr('=')
    blank()
  }
  function subheading (text) {
    blank()
    lines.push(text)
    hr('-')
    blank()
  }

  heading('DOCUMENT EMBEDDING BENCHMARK — FULL REPORT')

  lines.push('Date:     ' + meta.timestamp)
  lines.push('Device:   ' + meta.device)
  lines.push('Platform: ' + meta.platform.os + ' / ' + meta.platform.arch)
  lines.push('Warmup:   ' + WARMUP_RUNS + ' runs')
  lines.push('Repeats:  ' + BENCH_REPEATS + ' per config')
  lines.push('Scales:   ' + MULTIPLIERS.map(function (m) { return m + 'x' }).join(', '))
  blank()
  lines.push('Models tested:')
  for (const mr of allModelResults) {
    lines.push('  - ' + mr.label + ' (device: ' + mr.device + ', load: ' + mr.loadMs + 'ms)')
  }

  for (const mr of allModelResults) {
    heading('Results Summary — ' + mr.label + ' [' + mr.device + ']')

    for (const sr of mr.scaleResults) {
      subheading(sr.scaleLabel + ' Scale — ' + sr.docStats.words + ' words, ~' + sr.docStats.pages + ' pages')

      lines.push(
        padRight('Chunk Config', 32) +
        padRight('Chunks', 8) +
        padRight('Avg(ms)', 10) +
        padRight('Min(ms)', 10) +
        padRight('Max(ms)', 10) +
        padRight('TPS', 10) +
        'Chunks/s'
      )
      lines.push('-'.repeat(W))

      for (const r of sr.results) {
        lines.push(
          padRight(r.configLabel, 32) +
          padRight(String(r.numChunks), 8) +
          padRight(String(r.avgMs), 10) +
          padRight(String(r.minMs), 10) +
          padRight(String(r.maxMs), 10) +
          padRight(r.avgTps != null ? String(r.avgTps) : 'n/a', 10) +
          String(r.chunksPerSec)
        )
      }
      blank()

      for (const r of sr.results) {
        lines.push('  [' + r.configLabel + ']')
        lines.push('    Embeddings: ' + r.embeddingCount + ' x ' + r.embeddingDim + 'd')
        lines.push('    Runs: ' + r.timings.join('ms, ') + 'ms')
        const docsPerMin = round((60000 / r.avgMs), 1)
        lines.push('    Est. docs/min at this scale: ' + docsPerMin)
        blank()
      }
    }
  }

  heading('Scaling Analysis (1x to 10x Scale)')

  for (const mr of allModelResults) {
    subheading(mr.label)

    const scale1 = mr.scaleResults.find(function (s) { return s.multiplier === 1 })
    const scale10 = mr.scaleResults.find(function (s) { return s.multiplier === 10 })
    if (!scale1 || !scale10) continue

    lines.push(
      padRight('Chunk Config', 32) +
      padRight('1x ms', 10) +
      padRight('10x ms', 10) +
      padRight('Ratio', 8) +
      padRight('1x TPS', 10) +
      padRight('10x TPS', 10) +
      'TPS delta'
    )
    lines.push('-'.repeat(W))

    for (let i = 0; i < CHUNK_CONFIGS.length; i++) {
      const r1 = scale1.results[i]
      const r10 = scale10.results[i]
      const ratio = round(r10.avgMs / r1.avgMs, 1)
      const tps1 = r1.avgTps != null ? String(r1.avgTps) : 'n/a'
      const tps10 = r10.avgTps != null ? String(r10.avgTps) : 'n/a'
      let tpsDelta = 'n/a'
      if (r1.avgTps != null && r10.avgTps != null && r1.avgTps > 0) {
        const pct = round(((r10.avgTps - r1.avgTps) / r1.avgTps) * 100, 1)
        tpsDelta = (pct >= 0 ? '+' : '') + pct + '%'
      }
      lines.push(
        padRight(r1.configLabel, 32) +
        padRight(String(r1.avgMs), 10) +
        padRight(String(r10.avgMs), 10) +
        padRight(ratio + 'x', 8) +
        padRight(tps1, 10) +
        padRight(tps10, 10) +
        tpsDelta
      )
    }
    blank()

    lines.push('  Observations:')
    for (let i = 0; i < CHUNK_CONFIGS.length; i++) {
      const r1 = scale1.results[i]
      const r10 = scale10.results[i]
      const ratio = round(r10.avgMs / r1.avgMs, 1)
      const chunkRatio = round(r10.numChunks / r1.numChunks, 1)
      const efficiency = round((chunkRatio / ratio) * 100, 1)
      lines.push('  - ' + r1.configLabel + ': ' + ratio + 'x time for ' + chunkRatio + 'x chunks (' + efficiency + '% linear scaling efficiency)')
    }
    blank()
  }

  heading('Key Findings & Recommendations')

  const findings = []

  for (const mr of allModelResults) {
    const scale1 = mr.scaleResults.find(function (s) { return s.multiplier === 1 })
    const scale10 = mr.scaleResults.find(function (s) { return s.multiplier === 10 })
    if (!scale1 || !scale10) continue

    let bestTps = 0
    let bestTpsChunk = ''
    let bestScale = ''
    for (const sr of mr.scaleResults) {
      for (const r of sr.results) {
        if (r.avgTps != null && r.avgTps > bestTps) {
          bestTps = r.avgTps
          bestTpsChunk = r.configLabel
          bestScale = sr.scaleLabel
        }
      }
    }

    const mediumResults = mr.scaleResults.map(function (sr) { return sr.results[1] })
    const tpsArr = mediumResults.map(function (r) { return r.avgTps }).filter(function (t) { return t != null })
    const avgTpsAcrossScales = tpsArr.length > 0 ? round(tpsArr.reduce(function (a, b) { return a + b }, 0) / tpsArr.length) : null

    findings.push({
      label: mr.label,
      loadMs: mr.loadMs,
      bestTps,
      bestTpsChunk,
      bestScale,
      avgTpsMedium: avgTpsAcrossScales,
      dim: scale1.results[0].embeddingDim
    })
  }

  for (const f of findings) {
    lines.push(f.label + ':')
    lines.push('  - Load time: ' + f.loadMs + 'ms')
    lines.push('  - Embedding dimension: ' + f.dim + 'd')
    lines.push('  - Peak throughput: ' + f.bestTps + ' TPS (' + f.bestTpsChunk + ' @ ' + f.bestScale + ')')
    if (f.avgTpsMedium != null) {
      lines.push('  - Avg TPS (medium chunks, all scales): ' + f.avgTpsMedium)
    }
    blank()
  }

  lines.push('Recommendations:')
  blank()

  if (findings.length >= 2) {
    const sorted = findings.slice().sort(function (a, b) { return b.bestTps - a.bestTps })
    const faster = sorted[0]
    const slower = sorted[1]
    if (faster.bestTps > 0 && slower.bestTps > 0) {
      const speedup = round(faster.bestTps / slower.bestTps, 1)
      lines.push('  - ' + faster.label + ' achieves ' + speedup + 'x higher peak TPS than ' + slower.label)
    }
    if (faster.loadMs < slower.loadMs) {
      lines.push('  - ' + faster.label + ' also loads faster (' + faster.loadMs + 'ms vs ' + slower.loadMs + 'ms)')
    }
  }

  lines.push('  - Larger chunks (256w) produce fewer embeddings with higher throughput per chunk')
  lines.push('  - Smaller chunks (64w) offer finer retrieval granularity at the cost of more embeddings')
  lines.push('  - For bulk ingestion, prefer large batch sizes with 256w chunks to maximize throughput')
  lines.push('  - For interactive/real-time use, medium chunks (128w) balance latency and quality')

  heading('Comparison: EmbeddingGemma-300M vs. GTE-Large')

  if (findings.length >= 2) {
    const gteF = findings.find(function (f) { return f.label.indexOf('GTE') !== -1 })
    const gemmaF = findings.find(function (f) { return f.label.indexOf('Gemma') !== -1 })
    const gteR = allModelResults.find(function (m) { return m.modelKey === 'gte' })
    const gemmaR = allModelResults.find(function (m) { return m.modelKey === 'gemma' })

    if (gteF && gemmaF && gteR && gemmaR) {
      lines.push(
        padRight('Metric', 36) +
        padRight(gteF.label, 22) +
        gemmaF.label
      )
      lines.push('-'.repeat(W))
      lines.push(
        padRight('Embedding Dimension', 36) +
        padRight(gteF.dim + 'd', 22) +
        gemmaF.dim + 'd'
      )
      lines.push(
        padRight('Model Load Time', 36) +
        padRight(gteF.loadMs + 'ms', 22) +
        gemmaF.loadMs + 'ms'
      )
      lines.push(
        padRight('Peak TPS', 36) +
        padRight(String(gteF.bestTps), 22) +
        String(gemmaF.bestTps)
      )
      if (gteF.avgTpsMedium != null && gemmaF.avgTpsMedium != null) {
        lines.push(
          padRight('Avg TPS (medium chunks)', 36) +
          padRight(String(gteF.avgTpsMedium), 22) +
          String(gemmaF.avgTpsMedium)
        )
      }
      blank()

      for (const sr of gteR.scaleResults) {
        const gemmaSr = gemmaR.scaleResults.find(function (s) { return s.multiplier === sr.multiplier })
        if (!gemmaSr) continue

        lines.push(sr.scaleLabel + ' scale:')
        lines.push(
          '  ' + padRight('Chunk Config', 30) +
          padRight('GTE ms', 10) +
          padRight('Gemma ms', 10) +
          padRight('GTE TPS', 10) +
          padRight('Gemma TPS', 10) +
          'Winner'
        )
        lines.push('  ' + '-'.repeat(W - 2))

        for (let i = 0; i < sr.results.length; i++) {
          const gR = sr.results[i]
          const eR = gemmaSr.results[i]
          let winner = 'tie'
          if (gR.avgMs < eR.avgMs) winner = 'GTE'
          else if (eR.avgMs < gR.avgMs) winner = 'Gemma'

          lines.push('  ' +
            padRight(gR.configLabel, 30) +
            padRight(String(gR.avgMs), 10) +
            padRight(String(eR.avgMs), 10) +
            padRight(gR.avgTps != null ? String(gR.avgTps) : 'n/a', 10) +
            padRight(eR.avgTps != null ? String(eR.avgTps) : 'n/a', 10) +
            winner
          )
        }
        blank()
      }

      blank()
      lines.push('Summary:')
      blank()

      if (gteF.bestTps > gemmaF.bestTps) {
        const ratio = round(gteF.bestTps / gemmaF.bestTps, 1)
        lines.push('  GTE-Large is ~' + ratio + 'x faster in peak TPS.')
      } else if (gemmaF.bestTps > gteF.bestTps) {
        const ratio = round(gemmaF.bestTps / gteF.bestTps, 1)
        lines.push('  EmbeddingGemma-300M is ~' + ratio + 'x faster in peak TPS.')
      } else {
        lines.push('  Both models have comparable peak TPS.')
      }

      if (gteF.dim !== gemmaF.dim) {
        lines.push('  GTE produces ' + gteF.dim + 'd embeddings, Gemma produces ' + gemmaF.dim + 'd.')
        if (gteF.dim > gemmaF.dim) {
          lines.push('  GTE\'s higher dimension may offer richer representations at the cost of more storage.')
        } else {
          lines.push('  Gemma\'s higher dimension may offer richer representations at the cost of more storage.')
        }
      }

      if (gteF.loadMs < gemmaF.loadMs) {
        lines.push('  GTE loads ' + round(gemmaF.loadMs / gteF.loadMs, 1) + 'x faster.')
      } else if (gemmaF.loadMs < gteF.loadMs) {
        lines.push('  Gemma loads ' + round(gteF.loadMs / gemmaF.loadMs, 1) + 'x faster.')
      }
    }
  } else {
    lines.push('  (Only one model was tested — comparison unavailable)')
  }

  blank()
  hr('=')
  lines.push('END OF REPORT')
  hr('=')
  blank()

  return lines.join('\n')
}

function toJsonLines (allModelResults, meta) {
  const lines = []

  for (const mr of allModelResults) {
    for (const sr of mr.scaleResults) {
      for (const r of sr.results) {
        lines.push(JSON.stringify({
          timestamp: meta.timestamp,
          device: mr.device,
          splitMode: meta.splitMode,
          tensorSplit: meta.tensorSplit,
          platform: meta.platform,
          warmupRuns: WARMUP_RUNS,
          benchRepeats: BENCH_REPEATS,
          modelKey: mr.modelKey,
          modelLabel: mr.label,
          modelFilename: mr.filename,
          loadMs: mr.loadMs,
          scale: sr.scaleLabel,
          multiplier: sr.multiplier,
          docWords: sr.docStats.words,
          docPages: sr.docStats.pages,
          chunkConfig: r.configLabel,
          numChunks: r.numChunks,
          embeddingCount: r.embeddingCount,
          embeddingDim: r.embeddingDim,
          avgMs: r.avgMs,
          minMs: r.minMs,
          maxMs: r.maxMs,
          avgTps: r.avgTps,
          chunksPerSec: r.chunksPerSec,
          timings: r.timings
        }))
      }
    }
  }

  return lines.join('\n') + '\n'
}

function toMarkdown (allModelResults, meta) {
  const lines = []
  lines.push('# Document Embedding Benchmark Report')
  lines.push('')
  lines.push('- Date: ' + meta.timestamp)
  lines.push('- Device: ' + meta.device)
  lines.push('- Platform: ' + meta.platform.os + ' / ' + meta.platform.arch)
  lines.push('- Warmup: ' + WARMUP_RUNS + ' runs')
  lines.push('- Repeats: ' + BENCH_REPEATS + ' per config')
  lines.push('- Scales: ' + MULTIPLIERS.map(function (m) { return m + 'x' }).join(', '))
  lines.push('')

  for (const mr of allModelResults) {
    lines.push('## ' + mr.label)
    lines.push('')
    lines.push('Device: ' + mr.device)
    lines.push('Load time: ' + mr.loadMs + 'ms')
    lines.push('')

    for (const sr of mr.scaleResults) {
      lines.push('### ' + sr.scaleLabel + ' Scale (' + sr.docStats.words + ' words, ~' + sr.docStats.pages + ' pages)')
      lines.push('')
      lines.push('| Chunk Config | Chunks | Avg (ms) | Min (ms) | Max (ms) | TPS | Chunks/s |')
      lines.push('|---|---:|---:|---:|---:|---:|---:|')

      for (const r of sr.results) {
        lines.push(
          '| ' + r.configLabel +
          ' | ' + r.numChunks +
          ' | ' + r.avgMs +
          ' | ' + r.minMs +
          ' | ' + r.maxMs +
          ' | ' + (r.avgTps != null ? r.avgTps : 'n/a') +
          ' | ' + r.chunksPerSec + ' |'
        )
      }
      lines.push('')
    }
  }

  return lines.join('\n') + '\n'
}

function writeFullReport (allModelResults, splitMode, tensorSplit) {
  const reportDir = path.resolve(__dirname, 'results')
  fs.mkdirSync(reportDir, { recursive: true })

  const devices = [...new Set(allModelResults.map(function (mr) { return mr.device }))]
  const deviceLabel = devices.join(', ')

  const now = new Date()
  const meta = {
    timestamp: now.toISOString(),
    device: deviceLabel,
    splitMode,
    tensorSplit: tensorSplit || null,
    platform: { os: os.platform(), arch: os.arch() }
  }

  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const stamp = yyyy + mm + dd + '-' + hh + mi + ss

  const reportText = generateReport(allModelResults, meta)
  const textPath = path.join(reportDir, 'document-throughput-' + stamp + '.txt')
  fs.writeFileSync(textPath, reportText)
  console.log('\nReport saved to: ' + textPath)

  const jsonlContent = toJsonLines(allModelResults, meta)
  const jsonlPath = path.join(reportDir, 'document-throughput-' + stamp + '.jsonl')
  fs.writeFileSync(jsonlPath, jsonlContent)
  console.log('JSONL data saved to: ' + jsonlPath)

  const mdContent = toMarkdown(allModelResults, meta)
  const mdPath = path.join(reportDir, 'document-throughput-' + stamp + '.md')
  fs.writeFileSync(mdPath, mdContent)
  console.log('Markdown saved to: ' + mdPath)

  return { textPath, jsonlPath, mdPath, reportText }
}

async function main () {
  const args = parseArgs(process.argv)
  const device = args.device || 'gpu'
  const batchSize = parseInt(args['batch-size'] || '2048', 10)
  const splitMode = args['split-mode'] || 'none'
  const tensorSplit = args['tensor-split'] || null

  console.log('=== Document Embedding Benchmark: GTE vs EmbeddingGemma ===')
  console.log('Scales: ' + MULTIPLIERS.map(function (m) { return m + 'x' }).join(', '))
  console.log('Chunk configs: ' + CHUNK_CONFIGS.length)
  console.log('')

  const allModelResults = []

  for (const modelKey of Object.keys(MODELS)) {
    const result = await benchmarkModel(modelKey, MODELS[modelKey], device, batchSize, splitMode, tensorSplit)
    allModelResults.push(result)
  }

  const { reportText } = writeFullReport(allModelResults, splitMode, tensorSplit)

  console.log('\n')
  console.log(reportText)
}

main().catch((error) => {
  console.error('Benchmark failed:')
  console.error(error.stack || String(error))
  process.exit(1)
})
