declare const harness: {
  resolve(
    id: string,
    args?: string[]
  ): Promise<import('../src/android-runtime-bridge').RemoteBundle>
}

export default harness
