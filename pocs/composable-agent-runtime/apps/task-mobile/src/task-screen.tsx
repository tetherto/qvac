import {
  ActivityIndicator,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'
import type {
  MobileSyncSnapshot,
  MobileSyncState,
  MobileSyncTask
} from './mobile-sync-client.ts'
import { taskScreenStyles as styles } from './task-screen.styles.ts'
import {
  connectionCopy,
  taskFormError,
  taskStatusCopy
} from './task-ui.ts'

interface ConnectionPanelProps {
  readonly snapshot: MobileSyncSnapshot
  readonly pairingUri: string
  readonly pairingError: string | null
  readonly onPairingUriChange: (value: string) => void
  readonly onPair: () => void
  readonly onCancel: () => void
  readonly onReconnect: () => void
}

export function ConnectionPanel(props: ConnectionPanelProps) {
  const copy = connectionCopy(props.snapshot)
  const waiting =
    props.snapshot.state === 'connecting' ||
    props.snapshot.state === 'awaiting-approval'

  return (
    <View style={styles.connectionPanel}>
      <View style={styles.connectionHeader}>
        <View
          style={[
            styles.connectionDot,
            connectionDotStyle(props.snapshot.state)
          ]}
        />
        <View style={styles.connectionCopy}>
          <Text style={styles.connectionLabel}>{copy.label}</Text>
          <Text style={styles.connectionDetail}>{copy.detail}</Text>
        </View>
        {waiting ? <ActivityIndicator color="#f5b942" /> : null}
      </View>

      {props.snapshot.state !== 'writable' ? (
        <>
          <Text style={styles.inputLabel}>Pairing URI</Text>
          <TextInput
            accessibilityLabel="Pairing URI"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={props.onPairingUriChange}
            placeholder="qvac-poc://pair?invite=..."
            placeholderTextColor="#667080"
            style={[styles.input, styles.uriInput]}
            value={props.pairingUri}
          />
          {props.pairingError ? (
            <Text style={styles.formError}>{props.pairingError}</Text>
          ) : null}
          <View style={styles.connectionActions}>
            <PrimaryButton
              label="Request pairing"
              disabled={waiting || props.pairingUri.trim().length === 0}
              onPress={props.onPair}
            />
            {waiting ? (
              <SecondaryButton
                label="Cancel pairing"
                onPress={props.onCancel}
              />
            ) : null}
            {props.snapshot.state === 'offline' ||
            props.snapshot.state === 'error' ? (
              <SecondaryButton
                label="Reconnect saved session"
                onPress={props.onReconnect}
              />
            ) : null}
          </View>
        </>
      ) : null}
    </View>
  )
}

interface TaskComposerProps {
  readonly state: MobileSyncState
  readonly title: string
  readonly prompt: string
  readonly error: string | null
  readonly creating: boolean
  readonly onTitleChange: (value: string) => void
  readonly onPromptChange: (value: string) => void
  readonly onCreate: () => void
}

export function TaskComposer(props: TaskComposerProps) {
  const validationError = taskFormError(
    props.state,
    props.title,
    props.prompt
  )
  return (
    <View style={styles.composer}>
      <Text style={styles.sectionNumber}>01 / DISPATCH</Text>
      <Text style={[styles.sectionTitle, styles.composerTitle]}>New task</Text>
      <Text style={styles.inputLabel}>Title</Text>
      <TextInput
        accessibilityLabel="Task title"
        editable={props.state === 'writable' && !props.creating}
        onChangeText={props.onTitleChange}
        placeholder="Research brief"
        placeholderTextColor="#667080"
        style={styles.input}
        value={props.title}
      />
      <Text style={styles.inputLabel}>Prompt</Text>
      <TextInput
        accessibilityLabel="Task prompt"
        editable={props.state === 'writable' && !props.creating}
        multiline
        onChangeText={props.onPromptChange}
        placeholder="Ask Qwen to analyze, draft, or explain..."
        placeholderTextColor="#667080"
        style={[styles.input, styles.promptInput]}
        textAlignVertical="top"
        value={props.prompt}
      />
      {props.error ? <Text style={styles.formError}>{props.error}</Text> : null}
      <PrimaryButton
        label={props.creating ? 'Creating...' : 'Create task'}
        disabled={validationError !== null || props.creating}
        onPress={props.onCreate}
      />
    </View>
  )
}

export function TaskFeed({
  tasks
}: {
  readonly tasks: readonly MobileSyncTask[]
}) {
  return (
    <View style={styles.feed}>
      <Text style={styles.sectionNumber}>02 / LIVE QUEUE</Text>
      <View style={styles.feedHeader}>
        <Text style={styles.sectionTitle}>Task snapshots</Text>
        <Text style={styles.taskCount}>
          {tasks.length.toString().padStart(2, '0')}
        </Text>
      </View>
      {tasks.length === 0 ? (
        <View style={styles.emptyFeed}>
          <Text style={styles.emptyFeedTitle}>No replicated tasks yet</Text>
          <Text style={styles.emptyFeedText}>
            New tasks and incremental Qwen output will appear here.
          </Text>
        </View>
      ) : (
        tasks.map((task) => <TaskCard key={task.id} task={task} />)
      )}
    </View>
  )
}

function TaskCard({ task }: { readonly task: MobileSyncTask }) {
  return (
    <View style={styles.taskCard}>
      <View style={styles.taskHeader}>
        <Text style={styles.taskTitle}>{task.title}</Text>
        <Text style={[styles.taskBadge, taskBadgeStyle(task.status)]}>
          {taskStatusCopy(task.status)}
        </Text>
      </View>
      <Text style={styles.taskPrompt}>{task.input}</Text>
      {task.result ? (
        <View style={styles.output}>
          <Text style={styles.outputLabel}>
            QWEN OUTPUT{task.status === 'running' ? '  ●' : ''}
          </Text>
          <Text selectable style={styles.outputText}>
            {task.result}
          </Text>
        </View>
      ) : (
        <Text style={styles.waitingOutput}>
          {task.status === 'failed'
            ? 'Qwen did not return output.'
            : 'Waiting for Qwen output...'}
        </Text>
      )}
    </View>
  )
}

export function SecondaryButton({
  label,
  disabled = false,
  onPress
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onPress: () => void
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.secondaryButton, disabled ? styles.disabledControl : null]}
    >
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </TouchableOpacity>
  )
}

function PrimaryButton({
  label,
  disabled = false,
  onPress
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onPress: () => void
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.primaryButton, disabled ? styles.disabledControl : null]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </TouchableOpacity>
  )
}

function connectionDotStyle(state: MobileSyncState) {
  if (state === 'writable') return styles.onlineDot
  if (state === 'error') return styles.failureDot
  if (state === 'offline' || state === 'idle') return styles.offlineDot
  return styles.waitingDot
}

function taskBadgeStyle(status: MobileSyncTask['status']) {
  if (status === 'running') return styles.runningTask
  if (status === 'completed') return styles.completedTask
  if (status === 'failed') return styles.failedTask
  if (status === 'cancelled') return styles.cancelledTask
  return styles.pendingTask
}
