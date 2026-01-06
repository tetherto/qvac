// Accuracy tests for transcription
require('./helpers.cjs')

async function test_en_shortAudio_noVad_streaming() {
    try {
        const model = await _loadModel()
        const audioStream = await _createAudioStream(getAssetPath('short_en.raw'))
        const response = await model.run(audioStream)
        const actual = await _streamResponse(response)
        await model.destroy()
        const expected = short_en_transcription
        return _validateResponse(expected, actual)
    } catch (error) {
        console.error('Error during test_en_shortAudio_noVad_streaming:', error)
        throw error
    }
}

async function test_en_shortAudio_noVad_iterate() {
    try {
        const model = await _loadModel()
        const audioStream = await _createAudioStream(getAssetPath('short_en.raw'))
        const response = await model.run(audioStream)
        const actual = await _iterateResponse(response)
        await model.destroy()
        const expected = short_en_transcription
        return _validateResponse(expected, actual)
    } catch (error) {
        console.error('Error during test_en_shortAudio_noVad_iterate:', error)
        throw error
    } 
}

async function test_en_shortAudio_Vad_streaming() {
    try {
        const model = await _loadModel(true)
        const audioStream = await _createAudioStream(getAssetPath('short_en.raw'))
        const response = await model.run(audioStream)
        const actual = await _streamResponse(response)
        await model.destroy()
        const expected = short_en_transcription
        return _validateResponse(expected, actual)
    } catch (error) {
        console.error('Error during test_en_shortAudio_Vad_streaming:', error)
        throw error
    } 
}

async function test_en_shortAudio_Vad_iterate() {
    try {
        const model = await _loadModel(true)
        const audioStream = await _createAudioStream(getAssetPath('short_en.raw'))
        const response = await model.run(audioStream)
        const actual = await _iterateResponse(response)
        await model.destroy()
        const expected = short_en_transcription
        return _validateResponse(expected, actual)
    } catch (error) {
        console.error('Error during test_en_shortAudio_Vad_iterate:', error)
        throw error
    } 
}

async function test_en_longAudio_noVad_streaming() {
    try {
        const model = await _loadModel()
        const audioStream = await _createAudioStream(getAssetPath('long_en.raw'))
        const response = await model.run(audioStream)
        const actual = await _streamResponse(response)
        await model.destroy()
        const expected = long_en_transcription
        return _validateResponse(expected, actual)
    } catch (error) {
        console.error('Error during test_en_longAudio_noVad_streaming:', error)
        throw error
    }
}

async function test_en_longAudio_noVad_iterate() {
    try {
        const model = await _loadModel()
        const audioStream = await _createAudioStream(getAssetPath('long_en.raw'))
        const response = await model.run(audioStream)
        const actual = await _iterateResponse(response)
        await model.destroy()
        const expected = long_en_transcription
        return _validateResponse(expected, actual)
    } catch (error) {
        console.error('Error during test_en_longAudio_noVad_iterate:', error)
        throw error
    }
}

async function test_en_longAudio_Vad_streaming() {
    try {
        const model = await _loadModel(true)
        const audioStream = await _createAudioStream(getAssetPath('long_en.raw'))
        const response = await model.run(audioStream)
        const actual = await _streamResponse(response)
        await model.destroy()
        const expected = long_en_transcription
        return _validateResponse(expected, actual)
    } catch (error) {
        console.error('Error during test_en_longAudio_Vad_streaming:', error)
        throw error
    }
}

async function test_en_longAudio_Vad_iterate() {
    try {
        const model = await _loadModel(true)
        const audioStream = await _createAudioStream(getAssetPath('long_en.raw'))
        const response = await model.run(audioStream)
        const actual = await _iterateResponse(response)
        await model.destroy()
        const expected = long_en_transcription
        return _validateResponse(expected, actual)
    } catch (error) {
        console.error('Error during test_en_longAudio_Vad_iterate:', error)
        throw error
    }
}

