import { useMicrophonePermissions } from "@speechmatics/expo-two-way-audio";

/**
 * Pre-test steps executor
 * Handles different types of pre-test actions (e.g., microphone recording)
 */

/**
 * Execute a pre-test step based on its type
 * @param {Object} preTestConfig - Configuration for the pre-test step
 * @param {Function} addMessage - Function to add messages to the UI
 * @returns {Promise<any>} - Data collected during the pre-test step
 */
export async function executePreTestStep(preTestConfig, addMessage) {
    const { type, ...params } = preTestConfig

    switch (type) {
        case 'recordMicrophone':
            return await recordMicrophone(params, addMessage)
        
        case 'custom':
            // Allow custom async functions to be passed
            if (typeof params.handler === 'function') {
                return await params.handler(addMessage)
            }
            throw new Error('Custom pre-test step requires a handler function')
        
        default:
            throw new Error(`Unknown pre-test step type: ${type}`)
    }
}

/**
 * Record audio from microphone using expo-two-way-audio
 * This function expects the audio recording infrastructure to be set up
 * at the component level with useExpoTwoWayAudioEventListener
 * 
 * @param {Object} params - Recording parameters
 * @param {number} params.duration - Duration in milliseconds
 * @param {Function} addMessage - Function to add messages to the UI
 * @param {Function} params.recordAudioFn - Function from component to trigger recording
 * @returns {Promise<Buffer>} - Recorded audio data as Buffer
 */
async function recordMicrophone(params, addMessage) {
    const { duration = 5000, recordAudioFn } = params
    
    if (!recordAudioFn) {
        throw new Error('recordAudioFn not provided. Audio recording infrastructure must be set up at component level.')
    }
    
    const { 
        initialize, 
        requestMicrophonePermissionsAsync
    } = require('@speechmatics/expo-two-way-audio')
    
    // Step 1: Check and request microphone permissions
    addMessage('Checking microphone permissions...')
    
    try {
        const permission = await requestMicrophonePermissionsAsync()
        
        if (!permission.granted) {
            throw new Error('Microphone permission denied. Please enable microphone access in settings.')
        }
        
        addMessage('Microphone permission granted')
    } catch (error) {
        throw new Error(`Permission error: ${error.message}`)
    }
    
    // Step 2: Initialize audio stream
    addMessage('Initializing audio stream...')
    try {
        await initialize()
        addMessage('Audio initialized')
    } catch (error) {
        console.log('Audio initialization warning:', error.message)
        // Continue anyway, might already be initialized
    }
    
    addMessage(`Recording for ${duration / 1000} seconds...`)
    
    // Use the recording function provided by the component
    try {
        const buffer = await recordAudioFn(duration, addMessage)
        
        if (!buffer || buffer.length === 0) {
            throw new Error('No audio data collected. Make sure microphone is working.')
        }
        
        addMessage(`Collected ${buffer.length} bytes of audio`)
        
        return buffer
    } catch (error) {
        throw new Error(`Recording failed: ${error.message}`)
    }
}

