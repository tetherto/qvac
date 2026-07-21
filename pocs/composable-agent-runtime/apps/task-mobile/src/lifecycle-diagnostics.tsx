import { useState } from 'react'
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native'
import type { ComponentName } from './protocol.ts'
import type { RunnerBroker, RuntimeSnapshot } from './runner-broker.ts'
import { SecondaryButton } from './task-screen.tsx'

export function LifecycleDiagnostics({
  broker,
  snapshots
}: {
  readonly broker: RunnerBroker
  readonly snapshots: readonly RuntimeSnapshot[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [running, setRunning] = useState(false)

  async function runProbe() {
    setRunning(true)
    try {
      await runAutomaticProbe(broker)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        style={styles.toggle}
      >
        <Text style={styles.toggleText}>Lifecycle diagnostics</Text>
        <Text style={styles.chevron}>{expanded ? '−' : '+'}</Text>
      </TouchableOpacity>

      {expanded ? (
        <View style={styles.diagnostics}>
          <View style={styles.warning}>
            <Text style={styles.warningTitle}>
              Hard crash can terminate this app
            </Text>
            <Text style={styles.warningText}>
              The SDK crash control calls the native bare-abort addon. It is not
              a graceful Worklet stop and may terminate the whole host process.
            </Text>
          </View>
          <SecondaryButton
            label={running ? 'Probe running...' : 'Run automatic lifecycle probe'}
            disabled={running}
            onPress={() => void runProbe()}
          />
          {snapshots.map((snapshot) => (
            <RuntimeCard
              key={snapshot.component}
              broker={broker}
              snapshot={snapshot}
            />
          ))}
          <View style={styles.measurements}>
            <Text style={styles.sectionTitle}>Measurement capture</Text>
            <Metric
              label="Cold ready"
              value={summarize(snapshots, 'coldReadyMs')}
            />
            <Metric
              label="Resume"
              value={summarize(snapshots, 'resumeMs')}
            />
            <Metric
              label="Host total memory"
              value="Pending physical device capture"
            />
            <Metric
              label="Incremental runtime memory"
              value="Pending physical device capture"
            />
            <Metric label="Model-load peak" value="Pending SDK model flow" />
            <Metric
              label="Background retained memory"
              value="Pending lifecycle run"
            />
            <Metric
              label="Bundle and native size"
              value="Bundle bytes emitted by build-worklets; native size pending release build"
            />
          </View>
        </View>
      ) : null}
    </>
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
    process.env.EXPO_PUBLIC_QVAC_PROBE_COMPONENTS ?? 'Harness,SDK'
  const components = requested.split(',').filter(isComponentName)
  if (components.length === 0) {
    throw new Error('EXPO_PUBLIC_QVAC_PROBE_COMPONENTS selected no runtimes')
  }
  return components
}

function isComponentName(value: string): value is ComponentName {
  return value === 'Harness' || value === 'SDK'
}

function RuntimeCard({
  broker,
  snapshot
}: {
  readonly broker: RunnerBroker
  readonly snapshot: RuntimeSnapshot
}) {
  const component = snapshot.component
  const isRunning =
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
          disabled={snapshot.state === 'starting' || isRunning}
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
          disabled={!isRunning}
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

function Metric({
  label,
  value
}: {
  readonly label: string
  readonly value: string
}) {
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
  toggle: {
    alignItems: 'center',
    borderTopColor: '#34373b',
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
    paddingVertical: 16
  },
  toggleText: {
    color: '#8d9298',
    fontSize: 13,
    fontWeight: '800'
  },
  chevron: {
    color: '#f5b942',
    fontFamily: 'Courier',
    fontSize: 20
  },
  diagnostics: { gap: 12 },
  warning: {
    backgroundColor: '#3a1d12',
    borderColor: '#ff7a45',
    borderRadius: 4,
    borderWidth: 1,
    padding: 14
  },
  warningTitle: { color: '#ffb091', fontSize: 16, fontWeight: '800' },
  warningText: { color: '#ffd4c3', lineHeight: 20, marginTop: 6 },
  card: {
    backgroundColor: '#191b1e',
    borderColor: '#34373b',
    borderRadius: 4,
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
  readyBadge: { backgroundColor: '#277c58' },
  suspendedBadge: { backgroundColor: '#7b5d17' },
  errorBadge: { backgroundColor: '#a33333' },
  neutralBadge: { backgroundColor: '#4b5158' },
  metadata: {
    color: '#9da2a8',
    fontFamily: 'Courier',
    fontSize: 11,
    marginTop: 3
  },
  error: { color: '#ff8c8c', marginTop: 10 },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14
  },
  control: {
    backgroundColor: '#386fa8',
    borderRadius: 3,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  dangerControl: { backgroundColor: '#b52e2e' },
  disabledControl: { opacity: 0.35 },
  controlText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  measurements: {
    backgroundColor: '#191b1e',
    borderRadius: 4,
    marginTop: 4,
    padding: 16
  },
  sectionTitle: {
    color: '#f4f1e8',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.4
  },
  metric: {
    borderBottomColor: '#34373b',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 9
  },
  metricLabel: { color: '#8b9096', fontSize: 12 },
  metricValue: { color: '#d9d9d2', fontSize: 13, marginTop: 3 }
})
