// Microphone recording tests
require('./helpers.cjs')

async function test_en_mic_transcription_noVad(audioData) {
    try {
        if (!audioData || audioData.length === 0) {
            throw new Error('Audio data is empty or undefined')
        }

        console.log(`Received audio data: ${audioData.length} bytes`)

        // Transcribe the audio with Whisper
        // Use s16le format since microphone data is typically 16-bit PCM
        const model = await _loadModel(false, 's16le')  // noVad, s16le format
        
        // Create a readable stream from the audio data
        const { Readable } = require('bare-stream')
        const audioStream = Readable.from(audioData)
        
        const response = await model.run(audioStream)
        const transcription = await _streamResponse(response)
        
        await model.destroy()
        
        console.log(`Transcription: ${transcription}`)
        
        return {
            fullText: transcription,
            audioBytes: audioData.length
        }
    } catch (error) {
        console.error('Error during test_en_mic_transcription:', error)
        throw error
    }
}

