// Helper functions for tests
require('./constants.cjs')

const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const fs = require('bare-fs')

async function _loadModel(isVad = false, audioFormat = 'f32le') {
    const hdDL = new HyperDriveDL({
        key: 'hd://ebfb94b378276da139554668f1ff737644eadff529c2ea0f2662d7df61fd86ca'
    })
    const constructorArgs = {
        modelName: 'ggml-tiny.bin',
        loader: hdDL,
        diskPath: `${dirPath}models`
    }
      // Configuration object
    let config;
    if (isVad) {
        config = {
            opts: { stats: true },
            whisperConfig: {
                audio_format: audioFormat,
                language: 'en',
                vad_model_path: `${dirPath}models/ggml-silero-v5.1.2.bin`,
                vad_params: {
                    threshold: 0.35,
                    min_speech_duration_ms: 200,
                    min_silence_duration_ms: 150,
                    max_speech_duration_s: 30,
                    speech_pad_ms: 600,
                    samples_overlap: 0.3
                }
            }
        }
    } else {
        config = {
            opts: { stats: true },
            whisperConfig: {
                audio_format: audioFormat,
                language: 'en'
            }
        }
    }
    const model = new TranscriptionWhispercpp(constructorArgs, config)
    await model._load()
    return model
}

async function _createAudioStream(audioFilePath) {
    const bytesPerSecond = bitRate / 8
    const audioStream = fs.createReadStream(audioFilePath, {
        highWaterMark: bytesPerSecond
    })
    return audioStream
}

function _wordErrorRate(expected, actual) {
    const r = expected.split(/\s+/);
    const h = actual.split(/\s+/);
    const d = Array(r.length + 1)
      .fill(null)
      .map(() => Array(h.length + 1).fill(0));
  
    for (let i = 0; i <= r.length; i++) d[i][0] = i;
    for (let j = 0; j <= h.length; j++) d[0][j] = j;
  
    for (let i = 1; i <= r.length; i++) {
      for (let j = 1; j <= h.length; j++) {
        const cost = r[i - 1] === h[j - 1] ? 0 : 1;
        d[i][j] = Math.min(
          d[i - 1][j] + 1, // deletion
          d[i][j - 1] + 1, // insertion
          d[i - 1][j - 1] + cost // substitution
        );
      }
    }
  
    const wer = d[r.length][h.length] / r.length;
    return wer;
}

function _validateResponse(expected, actual) {
    const wer = _wordErrorRate(expected, actual)
    if (wer > 0.3) {
        throw new Error(`Word Error Rate is too high: ${wer}`)
    }
    return { score: wer, fullText: actual }
}
  
async function _streamResponse(response) {
    let fullText = ''
    await response.onUpdate((output) => {
        if (Array.isArray(output)) {
            for (const item of output) {
                if (item.text) {
                    fullText += item.text
                }
            }
        }
    }).await()
    return fullText
}

async function _iterateResponse(response) {
    let fullText = ''
    for await (const output of response.iterate()) {
        if (Array.isArray(output)) {
            for (const item of output) {
                if (item.text) {
                    fullText += item.text
                }
            }
        }
    }
    return fullText
}

// Helper function for performance metrics with streaming
async function _measurePerformanceStreaming(model, audioPath, expected, testLabel) {
    console.log(`🚀 Starting performance measurement: ${testLabel}`)
    
    const audioStream = await _createAudioStream(audioPath)
    
    const metrics = {
        startTime: Date.now(),
        firstTokenTime: null,
        segments: 0,
        words: 0,
        fullText: ''
    }
    
    const response = await model.run(audioStream)
    
    response.on('stats', (stats) => {
        console.log('📊 Stats received:', JSON.stringify(stats, null, 2))
        metrics.addonStats = stats
    })
    
    response.onUpdate((output) => {
        if (Array.isArray(output)) {
            for (const item of output) {
                if (item.text && item.text.trim()) {
                    if (metrics.firstTokenTime === null) {
                        metrics.firstTokenTime = Date.now()
                        const ttft = (metrics.firstTokenTime - metrics.startTime) / 1000
                        console.log(`⚡ TTFT: ${ttft.toFixed(3)}s`)
                    }
                    metrics.segments++
                    const words = item.text.trim().split(/\s+/).filter(w => w.length > 0)
                    metrics.words += words.length
                    metrics.fullText += item.text
                }
            }
        }
    })
    
    await response.await()
    metrics.endTime = Date.now()
    
    const ttft = metrics.firstTokenTime ? (metrics.firstTokenTime - metrics.startTime) / 1000 : null
    const totalTime = (metrics.endTime - metrics.startTime) / 1000
    const sps = metrics.segments / totalTime
    const wps = metrics.words / totalTime
    
    const results = {
        ttft_seconds: parseFloat(ttft?.toFixed(3)),
        total_time_seconds: parseFloat(totalTime.toFixed(3)),
        segments: metrics.segments,
        words: metrics.words,
        sps: parseFloat(sps.toFixed(2)),
        wps: parseFloat(wps.toFixed(2)),
        stats: metrics.addonStats || {},
        fullText: metrics.fullText
    }
    
    console.log('\n📊 === PERFORMANCE METRICS ===')
    console.log(`   TTFT: ${results.ttft_seconds}s`)
    console.log(`   Total Time: ${results.total_time_seconds}s`)
    console.log(`   Segments: ${results.segments}`)
    console.log(`   Words: ${results.words}`)
    console.log(`   SPS (Segments Per Second): ${results.sps}`)
    console.log(`   WPS (Words Per Second): ${results.wps}`)
    if (results.stats && Object.keys(results.stats).length > 0) {
        console.log(`   Addon Stats: ${JSON.stringify(results.stats, null, 2)}`)
    }
    console.log('============================\n')
    
    const wer = _wordErrorRate(expected, metrics.fullText)
    if (wer > 0.3) {
        throw new Error(`Word Error Rate is too high: ${wer}`)
    }
    
    results.fullText = `${metrics.fullText}\n\n📊 === PERFORMANCE METRICS ===\n⚡ TTFT: ${results.ttft_seconds}s\n⏱️  Total Time: ${results.total_time_seconds}s\n📊 Segments: ${results.segments}\n📝 Words: ${results.words}\n🚀 SPS: ${results.sps}\n💬 WPS: ${results.wps}\n============================`
    
    return results
}

// Helper function for performance metrics with iterate
async function _measurePerformanceIterate(model, audioPath, expected, testLabel) {
    console.log(`🚀 Starting performance measurement: ${testLabel}`)
    
    const audioStream = await _createAudioStream(audioPath)
    
    const metrics = {
        startTime: Date.now(),
        firstTokenTime: null,
        segments: 0,
        words: 0,
        fullText: ''
    }
    
    const response = await model.run(audioStream)
    
    response.on('stats', (stats) => {
        console.log('📊 Stats received:', JSON.stringify(stats, null, 2))
        metrics.addonStats = stats
    })
    
    for await (const output of response.iterate()) {
        if (Array.isArray(output)) {
            for (const item of output) {
                if (item.text && item.text.trim()) {
                    if (metrics.firstTokenTime === null) {
                        metrics.firstTokenTime = Date.now()
                        const ttft = (metrics.firstTokenTime - metrics.startTime) / 1000
                        console.log(`⚡ TTFT: ${ttft.toFixed(3)}s`)
                    }
                    metrics.segments++
                    const words = item.text.trim().split(/\s+/).filter(w => w.length > 0)
                    metrics.words += words.length
                    metrics.fullText += item.text
                }
            }
        }
    }
    
    metrics.endTime = Date.now()
    
    const ttft = metrics.firstTokenTime ? (metrics.firstTokenTime - metrics.startTime) / 1000 : null
    const totalTime = (metrics.endTime - metrics.startTime) / 1000
    const sps = metrics.segments / totalTime
    const wps = metrics.words / totalTime
    
    const results = {
        ttft_seconds: parseFloat(ttft?.toFixed(3)),
        total_time_seconds: parseFloat(totalTime.toFixed(3)),
        segments: metrics.segments,
        words: metrics.words,
        sps: parseFloat(sps.toFixed(2)),
        wps: parseFloat(wps.toFixed(2)),
        stats: metrics.addonStats || {},
        fullText: metrics.fullText
    }
    
    console.log('\n📊 === PERFORMANCE METRICS ===')
    console.log(`   TTFT: ${results.ttft_seconds}s`)
    console.log(`   Total Time: ${results.total_time_seconds}s`)
    console.log(`   Segments: ${results.segments}`)
    console.log(`   Words: ${results.words}`)
    console.log(`   SPS (Segments Per Second): ${results.sps}`)
    console.log(`   WPS (Words Per Second): ${results.wps}`)
    if (results.stats && Object.keys(results.stats).length > 0) {
        console.log(`   Addon Stats: ${JSON.stringify(results.stats, null, 2)}`)
    }
    console.log('============================\n')
    
    const wer = _wordErrorRate(expected, metrics.fullText)
    if (wer > 0.3) {
        throw new Error(`Word Error Rate is too high: ${wer}`)
    }
    
    results.fullText = `${metrics.fullText}\n\n📊 === PERFORMANCE METRICS ===\n⚡ TTFT: ${results.ttft_seconds}s\n⏱️  Total Time: ${results.total_time_seconds}s\n📊 Segments: ${results.segments}\n📝 Words: ${results.words}\n🚀 SPS: ${results.sps}\n💬 WPS: ${results.wps}\n============================`
    
    return results
}

