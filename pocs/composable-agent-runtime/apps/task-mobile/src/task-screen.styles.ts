import { StyleSheet } from 'react-native'

export const taskScreenStyles = StyleSheet.create({
  connectionPanel: {
    backgroundColor: '#191b1e',
    borderColor: '#34373b',
    borderRadius: 4,
    borderWidth: 1,
    padding: 16
  },
  connectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12
  },
  connectionDot: {
    borderRadius: 6,
    height: 12,
    width: 12
  },
  onlineDot: { backgroundColor: '#63d88f' },
  waitingDot: { backgroundColor: '#f5b942' },
  offlineDot: { backgroundColor: '#757a80' },
  failureDot: { backgroundColor: '#ff716d' },
  connectionCopy: { flex: 1 },
  connectionLabel: {
    color: '#f4f1e8',
    fontSize: 16,
    fontWeight: '800'
  },
  connectionDetail: {
    color: '#989da3',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2
  },
  connectionActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12
  },
  composer: {
    backgroundColor: '#e9e4d8',
    borderRadius: 4,
    padding: 18
  },
  sectionNumber: {
    color: '#8c6612',
    fontFamily: 'Courier',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.4,
    marginBottom: 6
  },
  sectionTitle: {
    color: '#f4f1e8',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.4
  },
  composerTitle: { color: '#161719' },
  inputLabel: {
    color: '#858a90',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.7,
    marginBottom: 6,
    marginTop: 14,
    textTransform: 'uppercase'
  },
  input: {
    backgroundColor: '#111315',
    borderColor: '#383c40',
    borderRadius: 3,
    borderWidth: 1,
    color: '#f4f1e8',
    fontSize: 15,
    paddingHorizontal: 13,
    paddingVertical: 12
  },
  uriInput: {
    fontFamily: 'Courier',
    fontSize: 12,
    minHeight: 66,
    textAlignVertical: 'top'
  },
  promptInput: { minHeight: 112 },
  formError: {
    color: '#ff8f89',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 9
  },
  primaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#f5b942',
    borderRadius: 3,
    justifyContent: 'center',
    marginTop: 14,
    minHeight: 44,
    paddingHorizontal: 18
  },
  primaryButtonText: {
    color: '#15120b',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase'
  },
  secondaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: '#555a60',
    borderRadius: 3,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 14,
    minHeight: 44,
    paddingHorizontal: 14
  },
  secondaryButtonText: {
    color: '#d7d9db',
    fontSize: 12,
    fontWeight: '800'
  },
  disabledControl: { opacity: 0.35 },
  feed: {
    borderTopColor: '#35383b',
    borderTopWidth: 1,
    paddingTop: 18
  },
  feedHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12
  },
  taskCount: {
    color: '#656a70',
    fontFamily: 'Courier',
    fontSize: 18,
    fontWeight: '800'
  },
  emptyFeed: {
    borderColor: '#34373b',
    borderRadius: 4,
    borderStyle: 'dashed',
    borderWidth: 1,
    padding: 24
  },
  emptyFeedTitle: {
    color: '#c7c9c7',
    fontSize: 15,
    fontWeight: '800'
  },
  emptyFeedText: {
    color: '#797e84',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5
  },
  taskCard: {
    backgroundColor: '#191b1e',
    borderLeftColor: '#f5b942',
    borderLeftWidth: 3,
    marginBottom: 10,
    padding: 16
  },
  taskHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between'
  },
  taskTitle: {
    color: '#f4f1e8',
    flex: 1,
    fontSize: 17,
    fontWeight: '900'
  },
  taskBadge: {
    borderRadius: 2,
    color: '#111315',
    fontSize: 9,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 4,
    textTransform: 'uppercase'
  },
  pendingTask: { backgroundColor: '#f5b942' },
  runningTask: { backgroundColor: '#70b7ff' },
  completedTask: { backgroundColor: '#63d88f' },
  failedTask: { backgroundColor: '#ff716d' },
  cancelledTask: { backgroundColor: '#9ca1a6' },
  taskPrompt: {
    color: '#858a90',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8
  },
  output: {
    backgroundColor: '#101214',
    borderColor: '#2c3034',
    borderWidth: 1,
    marginTop: 14,
    padding: 13
  },
  outputLabel: {
    color: '#63d88f',
    fontFamily: 'Courier',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginBottom: 8
  },
  outputText: {
    color: '#d9d9d2',
    fontFamily: 'Courier',
    fontSize: 12,
    lineHeight: 19
  },
  waitingOutput: {
    color: '#6f7479',
    fontFamily: 'Courier',
    fontSize: 11,
    marginTop: 14
  }
})
