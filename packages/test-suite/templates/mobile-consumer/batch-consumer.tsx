import { useEffect, useState, useRef } from 'react'
import { View, Text, StyleSheet, ScrollView, Platform } from 'react-native'
import Constants from 'expo-constants'
import { ConsumerWrapper } from './consumer-wrapper'

interface BatchStats {
  testsCompleted: number
  testsPassed: number
  testsFailed: number
  testsSkipped: number
  totalTests: number
  currentTest: string
  isComplete: boolean
}

export default function BatchConsumer() {
  const scrollViewRef = useRef<ScrollView>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [stats, setStats] = useState<BatchStats>({
    testsCompleted: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    totalTests: 0,
    currentTest: '',
    isComplete: false
  })

  const addLog = (message: string) => {
    console.log(message)
    setLogs((prev) => [...prev.slice(-50), message])
  }

  const updateStats = (update: Partial<BatchStats>) => {
    setStats((prev) => ({ ...prev, ...update }))
  }

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: false })
  }, [logs])

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>QVAC Test Consumer (Mobile)</Text>
        <Text style={styles.device}>{Constants.deviceName || Platform.OS}</Text>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statBoxWide}>
          <Text style={styles.statValue}>
            {stats.testsCompleted} / {stats.totalTests}
          </Text>
          <Text style={styles.statLabel}>Progress</Text>
        </View>
      </View>
      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: '#4ade80' }]}>{stats.testsPassed}</Text>
          <Text style={styles.statLabel}>Pass</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: '#fbbf24' }]}>{stats.testsSkipped}</Text>
          <Text style={styles.statLabel}>Skip</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: '#f87171' }]}>{stats.testsFailed}</Text>
          <Text style={styles.statLabel}>Fail</Text>
        </View>
      </View>

      {stats.currentTest && !stats.isComplete && (
        <View style={styles.currentTestContainer}>
          <Text style={styles.currentTestLabel}>Current Test:</Text>
          <Text style={styles.currentTest}>{stats.currentTest}</Text>
        </View>
      )}

      {stats.isComplete && (
        <View style={styles.completeContainer}>
          <Text style={styles.completeText}>Batch Complete!</Text>
        </View>
      )}

      <View style={styles.logsContainer}>
        <Text style={styles.logsTitle}>Console Logs</Text>
        <ScrollView
          ref={scrollViewRef}
          style={styles.logsScroll}
          contentContainerStyle={styles.logsContent}
        >
          {logs.map((log, index) => (
            <Text key={index} style={styles.logLine}>
              {log}
            </Text>
          ))}
        </ScrollView>
      </View>

      <ConsumerWrapper log={addLog} updateStats={updateStats} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  header: {
    marginBottom: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#333'
  },
  title: { fontSize: 20, fontWeight: 'bold', color: '#fff', marginBottom: 4 },
  device: { fontSize: 12, color: '#888' },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 8,
    gap: 8
  },
  statBox: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center'
  },
  statBoxWide: {
    flex: 2,
    backgroundColor: '#1a1a1a',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center'
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#60a5fa',
    marginBottom: 4
  },
  statLabel: { fontSize: 10, color: '#888', textTransform: 'uppercase' },
  currentTestContainer: {
    backgroundColor: '#1a1a1a',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16
  },
  currentTestLabel: {
    fontSize: 10,
    color: '#888',
    textTransform: 'uppercase',
    marginBottom: 4
  },
  currentTest: { fontSize: 14, color: '#60a5fa', fontFamily: 'monospace' },
  completeContainer: {
    backgroundColor: '#1a1a1a',
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
    alignItems: 'center'
  },
  completeText: { fontSize: 18, color: '#4ade80', fontWeight: 'bold' },
  logsContainer: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    overflow: 'hidden'
  },
  logsTitle: {
    fontSize: 12,
    color: '#888',
    textTransform: 'uppercase',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#333'
  },
  logsScroll: { flex: 1 },
  logsContent: { padding: 12 },
  logLine: {
    fontSize: 11,
    color: '#ddd',
    fontFamily: 'monospace',
    marginBottom: 4
  }
})
