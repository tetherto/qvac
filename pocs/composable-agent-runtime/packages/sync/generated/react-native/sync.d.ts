declare const harness: {
  start(opts?: import('react-native-bare-kit').WorkletOptions, args?: readonly string[]): Promise<{ ipc: import('bare-stow/host').IPC }>
}

export default harness
