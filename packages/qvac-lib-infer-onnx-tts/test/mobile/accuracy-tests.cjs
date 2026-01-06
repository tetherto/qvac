require('./helpers.cjs')

async function testTts () {
  const model = await _loadModel()
  let fullText = ''
  let werSum = 0
  const totalBuffer = []
  for (const text of dataset) {
    const buffer = await _runTTS(model, text)

    if (buffer.length === 0) {
      throw new Error('No audio data received')
    }

    totalBuffer.push(buffer)

    const result = await _transcribeAudio(text, buffer)
    console.log('>>> [TRANSCRIPTION] Transcription completed', result.transcription)
    fullText += `${result.transcription}\n`
    werSum += result.wer
  }
  const wavBuffer = _createWav(totalBuffer.flat())
  const audioData = Buffer.from(wavBuffer).toString('base64')
  return { audioData, score: werSum / dataset.length, fullText: fullText }
}
