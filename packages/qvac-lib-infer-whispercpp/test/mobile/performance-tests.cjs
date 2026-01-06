// Performance metrics tests
require('./helpers.cjs')

async function test_performance_metrics_short() {
    try {
        const model = await _loadModel()
        const result = await _measurePerformanceStreaming(
            model, 
            getAssetPath('short_en.raw'), 
            short_en_transcription,
            'Short Audio - No VAD - Streaming'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_performance_metrics_short:', error)
        throw error
    }
}

async function test_performance_metrics_long() {
    try {
        const model = await _loadModel()
        const result = await _measurePerformanceStreaming(
            model, 
            getAssetPath('long_en.raw'), 
            long_en_transcription,
            'Long Audio - No VAD - Streaming'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_performance_metrics_long:', error)
        throw error
    }
}

// Performance tests: Short Audio + No VAD + Streaming
async function test_perf_short_noVad_streaming() {
    try {
        const model = await _loadModel(false)
        const result = await _measurePerformanceStreaming(
            model, 
            getAssetPath('short_en.raw'), 
            short_en_transcription,
            'Short Audio - No VAD - Streaming'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_perf_short_noVad_streaming:', error)
        throw error
    }
}

// Performance tests: Short Audio + No VAD + Iterate
async function test_perf_short_noVad_iterate() {
    try {
        const model = await _loadModel(false)
        const result = await _measurePerformanceIterate(
            model, 
            getAssetPath('short_en.raw'), 
            short_en_transcription,
            'Short Audio - No VAD - Iterate'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_perf_short_noVad_iterate:', error)
        throw error
    }
}

// Performance tests: Short Audio + VAD + Streaming
async function test_perf_short_Vad_streaming() {
    try {
        const model = await _loadModel(true)
        const result = await _measurePerformanceStreaming(
            model, 
            getAssetPath('short_en.raw'), 
            short_en_transcription,
            'Short Audio - VAD - Streaming'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_perf_short_Vad_streaming:', error)
        throw error
    }
}

// Performance tests: Short Audio + VAD + Iterate
async function test_perf_short_Vad_iterate() {
    try {
        const model = await _loadModel(true)
        const result = await _measurePerformanceIterate(
            model, 
            getAssetPath('short_en.raw'), 
            short_en_transcription,
            'Short Audio - VAD - Iterate'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_perf_short_Vad_iterate:', error)
        throw error
    }
}

// Performance tests: Long Audio + No VAD + Streaming
async function test_perf_long_noVad_streaming() {
    try {
        const model = await _loadModel(false)
        const result = await _measurePerformanceStreaming(
            model, 
            getAssetPath('long_en.raw'), 
            long_en_transcription,
            'Long Audio - No VAD - Streaming'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_perf_long_noVad_streaming:', error)
        throw error
    }
}

// Performance tests: Long Audio + No VAD + Iterate
async function test_perf_long_noVad_iterate() {
    try {
        const model = await _loadModel(false)
        const result = await _measurePerformanceIterate(
            model, 
            getAssetPath('long_en.raw'), 
            long_en_transcription,
            'Long Audio - No VAD - Iterate'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_perf_long_noVad_iterate:', error)
        throw error
    }
}

// Performance tests: Long Audio + VAD + Streaming
async function test_perf_long_Vad_streaming() {
    try {
        const model = await _loadModel(true)
        const result = await _measurePerformanceStreaming(
            model, 
            getAssetPath('long_en.raw'), 
            long_en_transcription,
            'Long Audio - VAD - Streaming'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_perf_long_Vad_streaming:', error)
        throw error
    }
}

// Performance tests: Long Audio + VAD + Iterate
async function test_perf_long_Vad_iterate() {
    try {
        const model = await _loadModel(true)
        const result = await _measurePerformanceIterate(
            model, 
            getAssetPath('long_en.raw'), 
            long_en_transcription,
            'Long Audio - VAD - Iterate'
        )
        await model.destroy()
        return result
    } catch (error) {
        console.error('Error during test_perf_long_Vad_iterate:', error)
        throw error
    }
}

