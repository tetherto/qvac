declare const harness: {
  start(
    id: string,
    opts?: import('react-native-bare-kit').WorkletOptions
  ): Promise<{
    ipc: import('react-native-bare-kit').Worklet['IPC']
    worklet: import('react-native-bare-kit').Worklet
  }>
}

export default harness
