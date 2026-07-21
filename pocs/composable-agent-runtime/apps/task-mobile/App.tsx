import { useEffect, useState } from 'react'
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native'
import {
  createRunnerBroker,
  type RunnerBroker,
  type RuntimeSnapshot
} from './src/runner-broker'
import type { ComponentName } from './src/protocol'

export default function App() {
  const [, setRevision] = useState(0)
  const [broker] = useState(() =>
    createRunnerBroker(() => setRevision((revision) => revision + 1))
  )
  const snapshots = broker.snapshots()

  useEffect(() => {
    void runAutomaticProbe(broker)
  }, [broker])

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>PHYSICAL DEVICE FEASIBILITY GATE</Text>
        <Text style={styles.title}>Composable Runtime Host</Text>
        <Text style={styles.description}>
          Hermes owns the runner broker. Sync, Harness, and SDK are created as
          independent named BareKit Worklets.
        </Text>

        <View style={styles.warning}>
          <Text style={styles.warningTitle}>Hard crash can terminate this app</Text>
          <Text style={styles.warningText}>
            The SDK crash control calls the native bare-abort addon. It is
            intentionally not a graceful Worklet stop and may terminate the whole
            host process.
          </Text>
        </View>

        {snapshots.map((snapshot) => (
          <RuntimeCard
            key={snapshot.component}
            broker={broker}
            snapshot={snapshot}
          />
        ))}

        <View style={styles.measurements}>
          <Text style={styles.sectionTitle}>Measurement capture</Text>
          <Metric label="Cold ready" value={summarize(snapshots, 'coldReadyMs')} />
          <Metric label="Resume" value={summarize(snapshots, 'resumeMs')} />
          <Metric label="Host total memory" value="Pending physical device capture" />
          <Metric
            label="Incremental runtime memory"
            value="Pending physical device capture"
          />
          <Metric label="Model-load peak" value="Pending SDK model flow" />
          <Metric label="Background retained memory" value="Pending lifecycle run" />
          <Metric
            label="Bundle and native size"
            value="Bundle bytes emitted by build-worklets; native size pending release build"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

async function runAutomaticProbe(broker: RunnerBroker) {
  try {
    const components = automaticProbeComponents()
    await Promise.all(components.map((component) => broker.start(component)))
    await Promise.all(components.map((component) => broker.handshake(component)))
    logProbeSnapshots('handshake', broker.snapshots())
    await Promise.all(components.map((component) => broker.suspend(component)))
    await Promise.all(components.map((component) => broker.resume(component)))
    logProbeSnapshots('suspend-resume', broker.snapshots())
    if (process.env.EXPO_PUBLIC_QVAC_AUTO_CRASH_SDK === '1') {
      console.log('[isolation-probe] requesting SDK native abort')
      await new Promise((resolve) => setTimeout(resolve, 500))
      broker.hardCrashSdk()
    }
  } catch (error) {
    console.error(
      `[isolation-probe] failed ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    )
  }
}

function logProbeSnapshots(
  phase: string,
  snapshots: ReturnType<RunnerBroker['snapshots']>
) {
  for (const snapshot of snapshots) {
    console.log(
      `[isolation-probe] ${phase} ${snapshot.component} ${JSON.stringify(snapshot)}`
    )
  }
}

function automaticProbeComponents(): ComponentName[] {
  const requested =
    process.env.EXPO_PUBLIC_QVAC_PROBE_COMPONENTS ?? 'Sync,Harness,SDK'
  const components = requested.split(',').filter(isComponentName)
  if (components.length === 0) {
    throw new Error('EXPO_PUBLIC_QVAC_PROBE_COMPONENTS selected no runtimes')
  }
  return components
}

function isComponentName(value: string): value is ComponentName {
  return value === 'Sync' || value === 'Harness' || value === 'SDK'
}

function RuntimeCard({
  broker,
  snapshot
}: {
  readonly broker: RunnerBroker
  readonly snapshot: RuntimeSnapshot
}) {
  const component = snapshot.component
  const running =
    snapshot.state === 'ready' || snapshot.state === 'suspended'

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{component}</Text>
        <Text style={[styles.badge, badgeStyle(snapshot.state)]}>
          {snapshot.state.toUpperCase()}
        </Text>
      </View>

      <Text style={styles.metadata}>
        Runtime: {snapshot.metadata?.runtimeId ?? 'not reported'}
      </Text>
      <Text style={styles.metadata}>
        PID: {snapshot.metadata?.processId ?? 'not reported'}
      </Text>
      <Text style={styles.metadata}>
        Trace: {snapshot.lastTraceId ?? 'not emitted'}
      </Text>
      {snapshot.error ? <Text style={styles.error}>{snapshot.error}</Text> : null}

      <View style={styles.controls}>
        <Control
          label="Start"
          disabled={snapshot.state === 'starting' || running}
          action={() => run(() => broker.start(component))}
        />
        <Control
          label="Handshake"
          disabled={snapshot.state !== 'ready'}
          action={() => run(() => broker.handshake(component))}
        />
        <Control
          label="Suspend"
          disabled={snapshot.state !== 'ready'}
          action={() => run(() => broker.suspend(component))}
        />
        <Control
          label="Resume"
          disabled={snapshot.state !== 'suspended'}
          action={() => run(() => broker.resume(component))}
        />
        <Control
          label="Terminate"
          disabled={!running}
          action={() => run(() => broker.terminate(component))}
        />
        {component === 'SDK' ? (
          <Control
            label="Hard native crash"
            danger
            disabled={snapshot.state !== 'ready'}
            action={() => confirmHardCrash(broker)}
          />
        ) : null}
      </View>
    </View>
  )
}

function Control({
  label,
  action,
  disabled = false,
  danger = false
}: {
  readonly label: string
  readonly action: () => void
  readonly disabled?: boolean
  readonly danger?: boolean
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={action}
      style={[
        styles.control,
        danger ? styles.dangerControl : null,
        disabled ? styles.disabledControl : null
      ]}
    >
      <Text style={styles.controlText}>{label}</Text>
    </TouchableOpacity>
  )
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  )
}

function run(action: () => Promise<void>) {
  void action().catch((error: unknown) => {
    Alert.alert(
      'Runtime control failed',
      error instanceof Error ? error.message : String(error)
    )
  })
}

function confirmHardCrash(broker: RunnerBroker) {
  Alert.alert(
    'Crash the SDK runtime?',
    'This invokes native abort() inside the SDK Bare Worklet. The entire app may terminate.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Crash SDK',
        style: 'destructive',
        onPress: () => broker.hardCrashSdk()
      }
    ]
  )
}

function summarize(
  snapshots: readonly RuntimeSnapshot[],
  field: 'coldReadyMs' | 'resumeMs'
) {
  const measured = snapshots
    .filter((snapshot) => snapshot[field] !== null)
    .map((snapshot) => `${snapshot.component} ${snapshot[field]?.toFixed(1)} ms`)
  return measured.length > 0 ? measured.join(', ') : 'Not measured'
}

function badgeStyle(state: RuntimeSnapshot['state']) {
  if (state === 'ready') return styles.readyBadge
  if (state === 'suspended') return styles.suspendedBadge
  if (state === 'died' || state === 'error') return styles.errorBadge
  return styles.neutralBadge
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#07111f' },
  content: { padding: 20, paddingBottom: 48, gap: 16 },
  eyebrow: {
    color: '#42d3a4',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5
  },
  title: { color: '#f4f7fb', fontSize: 30, fontWeight: '800' },
  description: { color: '#9fb0c7', fontSize: 15, lineHeight: 22 },
  warning: {
    backgroundColor: '#3a1d12',
    borderColor: '#ff7a45',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14
  },
  warningTitle: { color: '#ffb091', fontSize: 16, fontWeight: '800' },
  warningText: { color: '#ffd4c3', lineHeight: 20, marginTop: 6 },
  card: {
    backgroundColor: '#0e1b2d',
    borderColor: '#233a55',
    borderRadius: 14,
    borderWidth: 1,
    padding: 16
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12
  },
  cardTitle: { color: '#f4f7fb', fontSize: 21, fontWeight: '800' },
  badge: {
    borderRadius: 12,
    color: '#f4f7fb',
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 5
  },
  readyBadge: { backgroundColor: '#167451' },
  suspendedBadge: { backgroundColor: '#7b5d17' },
  errorBadge: { backgroundColor: '#a33333' },
  neutralBadge: { backgroundColor: '#334861' },
  metadata: { color: '#9fb0c7', fontFamily: 'Courier', fontSize: 11, marginTop: 3 },
  error: { color: '#ff8c8c', marginTop: 10 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  control: {
    backgroundColor: '#1c6bd1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  dangerControl: { backgroundColor: '#b52e2e' },
  disabledControl: { opacity: 0.35 },
  controlText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  measurements: {
    backgroundColor: '#0b1727',
    borderRadius: 14,
    marginTop: 4,
    padding: 16
  },
  sectionTitle: {
    color: '#f4f7fb',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 8
  },
  metric: {
    borderBottomColor: '#20334a',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 9
  },
  metricLabel: { color: '#8298b4', fontSize: 12 },
  metricValue: { color: '#d9e4f2', fontSize: 13, marginTop: 3 }
})
