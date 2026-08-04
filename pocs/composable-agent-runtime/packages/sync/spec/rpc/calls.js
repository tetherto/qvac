// Generated from schema/sync.ts. Do not edit.

function noop() {}

function armed(stream) {
  stream.on('error', noop)
  return stream
}

export function createCalls(rpc) {
  return {
    getIdentity: (input) => rpc.getIdentity(input),
    describeRuntime: (input) => rpc.describeRuntime(input),
    runtimeStatus: (input) => rpc.runtimeStatus(input),
    runtimeDiagnostics: (input) => rpc.runtimeDiagnostics(input),
    suspend: (input) => rpc.suspend(input),
    resume: (input) => rpc.resume(input),
    meshStatus: (input) => rpc.meshStatus(input),
    watchMeshStatus: (input) => armed(rpc.watchMeshStatus(input)),
    joinMesh: (input) => rpc.joinMesh(input),
    cancelMeshJoin: (input) => rpc.cancelMeshJoin(input),
    leaveMesh: (input) => rpc.leaveMesh(input),
    listDevices: (input) => rpc.listDevices(input),
    watchDevices: (input) => armed(rpc.watchDevices(input)),
    renameDevice: (input) => rpc.renameDevice(input),
    removeDevice: (input) => rpc.removeDevice(input),
    createPairingInvite: (input) => rpc.createPairingInvite(input),
    approvePairingRequest: (input) => rpc.approvePairingRequest(input),
    rejectPairingRequest: (input) => rpc.rejectPairingRequest(input),
    watchPairingRequests: (input) => armed(rpc.watchPairingRequests(input)),
    applyProfile: (input) => rpc.applyProfile(input),
    queryProfile: (input) => rpc.queryProfile(input),
    watchProfile: (input) => armed(rpc.watchProfile(input)),
  }
}
