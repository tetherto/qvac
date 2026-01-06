import { useState, useEffect, useCallback, useRef } from 'react'
import { Text, View, StyleSheet, ScrollView, TouchableOpacity } from 'react-native'
import useWorklet from './hooks/useWorklet'
import * as FileSystem from 'expo-file-system/legacy'
import { INIT, RUN_TEST } from '../backend/api.cjs'
import { loadAssetPaths } from './utils/assetLoader'
import { TEST_FUNCTIONS, TEST_CONFIG } from './testConfig'
import { playAudio } from './utils/audio'
import { executePreTestStep } from './utils/preTestSteps'
import { useExpoTwoWayAudioEventListener, toggleRecording } from '@speechmatics/expo-two-way-audio'
import { Buffer } from 'buffer'

const dirPath = `${FileSystem.documentDirectory.replace('file://', '')}`

// Categorize tests
const automatedTests = TEST_FUNCTIONS.filter(name => !TEST_CONFIG[name])
const manualTests = TEST_FUNCTIONS.filter(name => TEST_CONFIG[name])

export default function App() {
    const [rpc, rpcReady] = useWorklet({})
    const [messages, setMessages] = useState(['Initializing...'])
    const [assetPaths, setAssetPaths] = useState(null)
    const [initialized, setInitialized] = useState(false)
    const [capturedData, setCapturedData] = useState({})
    const [recordingState, setRecordingState] = useState({}) // { testName: { isRecording: boolean, startTime: number } }
    const [isTestRunning, setIsTestRunning] = useState(false) // Track if any test is currently running
    
    // Audio recording state for pre-test steps
    const audioChunksRef = useRef([])
    const isCollectingAudioRef = useRef(false)
    
    // Set up audio event listener for pre-test microphone recording
    useExpoTwoWayAudioEventListener('onMicrophoneData', useCallback((event) => {
        if (isCollectingAudioRef.current && event.data) {
            audioChunksRef.current.push(event.data)
        }
    }, []))
    
    // Function to start recording audio
    const startRecording = useCallback((testName, addMessage) => {
        try {
            // Clear previous chunks
            audioChunksRef.current = []
            isCollectingAudioRef.current = true
            
            // Start recording
            toggleRecording(true)
            addMessage(`Recording started... (Tap "Stop Recording" when done)`)
            
            // Update recording state
            setRecordingState(prev => ({
                ...prev,
                [testName]: {
                    isRecording: true,
                    startTime: Date.now()
                }
            }))
        } catch (error) {
            isCollectingAudioRef.current = false
            throw error
        }
    }, [])
    
    // Function to stop recording audio
    const stopRecording = useCallback(async (testName, addMessage) => {
        try {
            // Stop recording
            toggleRecording(false)
            isCollectingAudioRef.current = false
            
            const recordingInfo = recordingState[testName]
            const duration = recordingInfo ? (Date.now() - recordingInfo.startTime) / 1000 : 0
            addMessage(`Recording stopped (${duration.toFixed(1)}s recorded)`)
            
            // Give it a moment to process final chunks
            await new Promise(resolve => setTimeout(resolve, 200))
            
            // Combine all chunks into buffer
            const totalLength = audioChunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0)
            const combinedBuffer = new Uint8Array(totalLength)
            let offset = 0
            
            for (const chunk of audioChunksRef.current) {
                combinedBuffer.set(new Uint8Array(chunk), offset)
                offset += chunk.length
            }
            
            const buffer = Buffer.from(combinedBuffer)
            
            // Update recording state
            setRecordingState(prev => ({
                ...prev,
                [testName]: {
                    isRecording: false,
                    startTime: null
                }
            }))
            
            return buffer
            
        } catch (error) {
            isCollectingAudioRef.current = false
            setRecordingState(prev => ({
                ...prev,
                [testName]: {
                    isRecording: false,
                    startTime: null
                }
            }))
            try {
                toggleRecording(false)
            } catch (e) {
                // Ignore
            }
            throw error
        }
    }, [recordingState])

    // Load assets on mount
    useEffect(() => {
        loadAssetPaths()
            .then(paths => {
                console.log('Asset paths loaded:', paths)
                setAssetPaths(paths)
            })
            .catch(error => {
                console.error('Failed to load assets:', error)
                addMessage('Failed to load assets')
            })
    }, [])

    useEffect(() => {
        if (rpcReady && assetPaths !== null) {
            setTimeout(() => {
                init()
            }, 3000)
        }
    }, [rpcReady, assetPaths])

    // Helper function to add a message to the list
    function addMessage(msg) {
        setMessages(prev => [...prev, msg])
    }

    async function init() {
        if (!rpc) {
            addMessage('RPC NOT WORKING')
            return
        }
        console.log('INITIALIZING', dirPath)
        console.log('Asset paths:', assetPaths)
        
        const request = rpc.request(INIT)
        // Send asset paths along with dirPath as JSON
        request.send(JSON.stringify({ dirPath, assetPaths }))
        const response = await request.reply('utf8')
        addMessage(response.toString())
        setInitialized(true)
        addMessage('\nReady! Use buttons below to run tests.')
    }

    async function runAutomatedTests() {
        if (isTestRunning) {
            addMessage('⚠️ Cannot run automated tests: A test is already running')
            return
        }
        
        setIsTestRunning(true)
        try {
            console.log('Running automated tests:', automatedTests)
            addMessage(`\n=== Running ${automatedTests.length} Automated Test(s) ===`)
            
            for (const testName of automatedTests) {
                await runTest(testName)
            }
            
            addMessage('\nAutomated tests completed!')
        } finally {
            setIsTestRunning(false)
        }
    }

    async function startCaptureInputForTest(testName) {
        if (isTestRunning) {
            addMessage('⚠️ Cannot start recording: A test is already running')
            return
        }
        
        const testConfig = TEST_CONFIG[testName]
        if (!testConfig?.preTest) {
            addMessage(`${testName}: No pre-test configuration found`)
            return
        }

        try {
            setIsTestRunning(true)
            addMessage(`\n=== Starting capture for ${testName} ===`)
            
            // Check permissions first
            const { 
                initialize, 
                requestMicrophonePermissionsAsync
            } = require('@speechmatics/expo-two-way-audio')
            
            addMessage('Checking microphone permissions...')
            
            const permission = await requestMicrophonePermissionsAsync()
            
            if (!permission.granted) {
                throw new Error('Microphone permission denied. Please enable microphone access in settings.')
            }
            
            addMessage('Microphone permission granted')
            
            // Initialize audio stream
            addMessage('Initializing audio stream...')
            try {
                await initialize()
                addMessage('Audio initialized')
            } catch (error) {
                console.log('Audio initialization warning:', error.message)
                // Continue anyway, might already be initialized
            }
            
            // Start recording
            startRecording(testName, addMessage)
            
        } catch (error) {
            console.error(`Failed to start capture for ${testName}:`, error)
            addMessage(`${testName}: FAIL - Failed to start: ${error.message}`)
        }
    }
    
    async function stopCaptureInputForTest(testName) {
        try {
            const data = await stopRecording(testName, addMessage)
            
            if (!data || data.length === 0) {
                throw new Error('No audio data collected. Make sure microphone is working.')
            }
            
            // Store captured data
            setCapturedData(prev => ({
                ...prev,
                [testName]: data
            }))
            
            addMessage(`${testName}: Input captured successfully (${data.length} bytes)`)
        } catch (error) {
            console.error(`Failed to stop capture for ${testName}:`, error)
            addMessage(`${testName}: FAIL - Failed to stop: ${error.message}`)
        } finally {
            setIsTestRunning(false)
        }
    }

    async function runManualTest(testName) {
        if (isTestRunning) {
            addMessage('⚠️ Cannot run test: Another test is already running')
            return
        }
        
        const preTestData = capturedData[testName]
        
        if (!preTestData) {
            addMessage(`${testName}: Please capture input first`)
            return
        }

        setIsTestRunning(true)
        try {
            addMessage(`\n=== Running ${testName} ===`)
            
            const request = rpc.request(RUN_TEST)
            request.send(JSON.stringify({ 
                testName,
                preTestData 
            }))
            const response = await request.reply('utf8')
            const result = JSON.parse(response.toString())
            
            // Handle post-test result data
            if (result.result) {
                handleResultData(result.result)
            }
            
            if (result.success) {
                console.log(`✅ ${testName} passed`)
                addMessage(`${testName}: PASS`)
            } else {
                console.log(`❌ ${testName} failed:`, result.error)
                addMessage(`${testName}: FAIL - ${result.error}`)
            }
        } catch (error) {
            console.error(`Error running test ${testName}:`, error)
            addMessage(`${testName}: FAIL - ${error.message}`)
        } finally {
            setIsTestRunning(false)
        }
    }

    async function runTest(testName) {
        if (!rpc) {
            addMessage(`${testName}: FAIL - RPC not ready`)
            return
        }
        
        try {
            console.log(`Running test: ${testName}`)
            
            // Send test request (automated tests don't have pre-test data)
            const request = rpc.request(RUN_TEST)
            request.send(JSON.stringify({ 
                testName,
                preTestData: null
            }))
            const response = await request.reply('utf8')
            const result = JSON.parse(response.toString())
            
            // Handle post-test result data
            if (result.result) {
                handleResultData(result.result)
            }
            
            if (result.success) {
                console.log(`✅ ${testName} passed`)
                addMessage(`${testName}: PASS`)
            } else {
                console.log(`❌ ${testName} failed:`, result.error)
                addMessage(`${testName}: FAIL - ${result.error}`)
            }
        } catch (error) {
            console.error(`Error running test ${testName}:`, error)
            addMessage(`${testName}: FAIL - ${error.message}`)
        }
    }

    async function handleResultData(jsonResult) {
        if (jsonResult.audioData) {
            try {
                await playAudio(jsonResult.audioData)
                addMessage('Audio playback completed')
            } catch (error) {
                console.error('Failed to play audio:', error)
                addMessage(`Audio playback failed: ${error.message}`)
            }
        }
        if (jsonResult.fullText) {
            addMessage(`Full Text: ${jsonResult.fullText}`)
        }
        if (jsonResult.score) {
            addMessage(`Score: ${jsonResult.score}`)
        }
    }

    return (
        <View style={styles.container}>
            <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
                <Text style={styles.text} testID="text">
                    {messages.join('\n')}
                </Text>
                
                {initialized && (
                    <View style={styles.controlsContainer}>
                        <Text style={styles.sectionTitle}>Controls</Text>
                        
                        {/* Show status when tests are running */}
                        {isTestRunning && (
                            <View style={styles.statusContainer}>
                                <Text style={styles.statusText}>🔄 Test in progress...</Text>
                            </View>
                        )}
                        
                        {/* Automated Tests Button */}
                        <TouchableOpacity 
                            style={[
                                styles.button,
                                isTestRunning && styles.disabledButton
                            ]}
                            onPress={runAutomatedTests}
                            disabled={isTestRunning}
                        >
                            <Text style={[
                                styles.buttonText,
                                isTestRunning && styles.disabledText
                            ]}>
                                Run Automated Tests ({automatedTests.length})
                            </Text>
                        </TouchableOpacity>
                        
                        {/* Manual Tests Section */}
                        {manualTests.length > 0 && (
                            <View style={styles.manualTestsSection}>
                                <Text style={styles.sectionTitle}>Manual Tests</Text>
                                {manualTests.map(testName => {
                                    const isRecording = recordingState[testName]?.isRecording
                                    const hasCapturedData = !!capturedData[testName]
                                    const isThisTestActive = isRecording
                                    const canInteract = !isTestRunning || isThisTestActive
                                    
                                    return (
                                        <View key={testName} style={styles.manualTestRow}>
                                            <Text style={styles.testName}>{testName}</Text>
                                            <View style={styles.buttonRow}>
                                                {!isRecording ? (
                                                    <>
                                                        <TouchableOpacity 
                                                            style={[
                                                                styles.button, 
                                                                styles.smallButton,
                                                                !canInteract && styles.disabledButton
                                                            ]}
                                                            onPress={() => startCaptureInputForTest(testName)}
                                                            disabled={!canInteract}
                                                        >
                                                            <Text style={[
                                                                styles.buttonText,
                                                                !canInteract && styles.disabledText
                                                            ]}>
                                                                {hasCapturedData ? '🔴 Re-record' : '🔴 Start Recording'}
                                                            </Text>
                                                        </TouchableOpacity>
                                                        
                                                        <TouchableOpacity 
                                                            style={[
                                                                styles.button, 
                                                                styles.smallButton,
                                                                (!hasCapturedData || !canInteract) && styles.disabledButton
                                                            ]}
                                                            onPress={() => runManualTest(testName)}
                                                            disabled={!hasCapturedData || !canInteract}
                                                        >
                                                            <Text style={[
                                                                styles.buttonText,
                                                                (!hasCapturedData || !canInteract) && styles.disabledText
                                                            ]}>
                                                                Run Test
                                                            </Text>
                                                        </TouchableOpacity>
                                                    </>
                                                ) : (
                                                    <TouchableOpacity 
                                                        style={[styles.button, styles.recordingButton]}
                                                        onPress={() => stopCaptureInputForTest(testName)}
                                                    >
                                                        <Text style={styles.buttonText}>
                                                            ⏹ Stop Recording
                                                        </Text>
                                                    </TouchableOpacity>
                                                )}
                                            </View>
                                        </View>
                                    )
                                })}
                            </View>
                        )}
                    </View>
                )}
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'white',
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: 20,
        paddingTop: 60,
    },
    text: {
        color: 'black',
        fontSize: 14,
        fontFamily: 'monospace',
    },
    controlsContainer: {
        marginTop: 30,
        paddingTop: 20,
        borderTopWidth: 2,
        borderTopColor: '#333',
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#333',
        marginBottom: 15,
        marginTop: 10,
    },
    statusContainer: {
        backgroundColor: '#FFF3CD',
        padding: 12,
        borderRadius: 8,
        marginBottom: 15,
        borderWidth: 1,
        borderColor: '#FFC107',
    },
    statusText: {
        color: '#856404',
        fontSize: 14,
        fontWeight: '600',
        textAlign: 'center',
    },
    button: {
        backgroundColor: '#007AFF',
        padding: 15,
        borderRadius: 8,
        alignItems: 'center',
        marginBottom: 10,
    },
    buttonText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
    disabledButton: {
        backgroundColor: '#CCCCCC',
    },
    disabledText: {
        color: '#666666',
    },
    recordingButton: {
        backgroundColor: '#FF3B30',
        flex: 1,
    },
    manualTestsSection: {
        marginTop: 20,
    },
    manualTestRow: {
        marginBottom: 20,
        padding: 15,
        backgroundColor: '#F5F5F5',
        borderRadius: 8,
    },
    testName: {
        fontSize: 14,
        fontWeight: '600',
        color: '#333',
        marginBottom: 10,
        fontFamily: 'monospace',
    },
    buttonRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 10,
    },
    smallButton: {
        flex: 1,
        paddingVertical: 12,
        paddingHorizontal: 10,
    },
})
