import * as FileSystem from 'expo-file-system/legacy'
import { Audio } from 'expo-av'

export async function playAudio(audioData) {
  try {
    // Create a temporary file with timestamp
    const fileUri = FileSystem.documentDirectory + 'tts_audio_' + Date.now() + '.wav'
    
    // Write the base64 audio data to file
    await FileSystem.writeAsStringAsync(fileUri, audioData, {
      encoding: FileSystem.EncodingType.Base64
    })
    
    console.log('[Audio] Audio file saved to:', fileUri)
    
    // Create and configure the audio sound
    const { sound } = await Audio.Sound.createAsync(
      { uri: fileUri },
      { shouldPlay: false, isLooping: false }
    )
    
    // Set up audio status update listener
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded) {
        if (status.isPlaying) {
          console.log('[Audio] Audio playback started')
        } else if (!status.isPlaying && status.didJustFinish) {
          console.log('[Audio] Audio playback ended')
          // Clean up the audio file
          FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(console.error)
          // Unload the sound
          sound.unloadAsync().catch(console.error)
        }
      } else if (status.error) {
        console.error('[Audio] Audio playback error:', status.error)
        // Clean up the audio file on error
        FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(console.error)
      }
    })
    
    // Start playing the audio
    await sound.playAsync()
    console.log('[Audio] Audio playback initiated')
    
    return sound
  } catch (error) {
    console.error('[Audio] Error playing audio:', error)
    throw error
  }
}