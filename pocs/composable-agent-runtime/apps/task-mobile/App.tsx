import { useEffect, useState } from 'react'
import { SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native'
import { LifecycleDiagnostics } from './src/lifecycle-diagnostics'
import type {
  MobileSyncSnapshot,
  MobileSyncTask
} from './src/mobile-sync-client'
import { parsePairingUri } from './src/pairing-uri'
import { createRunnerBroker } from './src/runner-broker'
import {
  createPersistentMobileSyncClient,
  hasPersistentMobileSyncSession
} from './src/sync-client'
import {
  ConnectionPanel,
  TaskComposer,
  TaskFeed
} from './src/task-screen'
import { taskFormError, visibleTasks } from './src/task-ui'

export default function App() {
  const [, setRevision] = useState(0)
  const [broker] = useState(() =>
    createRunnerBroker(() => setRevision((revision) => revision + 1))
  )
  const [syncSnapshot, setSyncSnapshot] = useState<MobileSyncSnapshot>({
    state: 'idle',
    error: null
  })
  const [syncClient] = useState(() =>
    createPersistentMobileSyncClient(setSyncSnapshot)
  )
  const [pairingUri, setPairingUri] = useState('')
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [tasks, setTasks] = useState<readonly MobileSyncTask[]>([])
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (hasPersistentMobileSyncSession()) {
      void syncClient.reconnect().catch(() => {})
    }
    return () => {
      void syncClient.disconnect()
    }
  }, [syncClient])

  useEffect(() => {
    if (syncSnapshot.state !== 'writable') return
    return syncClient.watchTasks((nextTasks) => {
      setTasks(visibleTasks(nextTasks))
    })
  }, [syncClient, syncSnapshot.state])

  async function pair() {
    const candidate = pairingUri.trim()
    try {
      parsePairingUri(candidate)
      setPairingError(null)
      await syncClient.connect(candidate)
    } catch (error) {
      setPairingError(errorMessage(error))
    }
  }

  async function reconnect() {
    setPairingError(null)
    try {
      await syncClient.reconnect()
    } catch (error) {
      setPairingError(errorMessage(error))
    }
  }

  async function cancelPairing() {
    setPairingError(null)
    try {
      await syncClient.disconnect()
    } catch (error) {
      setPairingError(errorMessage(error))
    }
  }

  async function createTask() {
    const validationError = taskFormError(syncSnapshot.state, title, prompt)
    if (validationError) {
      setCreateError(validationError)
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const created = await syncClient.createTask({
        title: title.trim(),
        input: prompt.trim()
      })
      setTasks((current) =>
        visibleTasks([created, ...current.filter((task) => task.id !== created.id)])
      )
      setTitle('')
      setPrompt('')
    } catch (error) {
      setCreateError(errorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>QVAC POCKET QUEUE</Text>
        <Text style={styles.title}>Send work to Qwen.</Text>
        <Text style={styles.description}>
          Pair this phone with the desktop service, dispatch a task, and watch the
          answer arrive as Qwen generates it.
        </Text>
        <ConnectionPanel
          snapshot={syncSnapshot}
          pairingUri={pairingUri}
          pairingError={pairingError}
          onPairingUriChange={setPairingUri}
          onPair={() => void pair()}
          onCancel={() => void cancelPairing()}
          onReconnect={() => void reconnect()}
        />
        <TaskComposer
          state={syncSnapshot.state}
          title={title}
          prompt={prompt}
          error={createError}
          creating={creating}
          onTitleChange={setTitle}
          onPromptChange={setPrompt}
          onCreate={() => void createTask()}
        />
        <TaskFeed tasks={tasks} />
        <LifecycleDiagnostics broker={broker} snapshots={broker.snapshots()} />
      </ScrollView>
    </SafeAreaView>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101113' },
  content: { gap: 18, padding: 20, paddingBottom: 56 },
  eyebrow: {
    color: '#f5b942',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2.4,
    marginTop: 12
  },
  title: {
    color: '#f4f1e8',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -1.1,
    lineHeight: 40
  },
  description: {
    color: '#a5a7a8',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 4,
    maxWidth: 520
  }
})
