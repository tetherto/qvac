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
    getUserProfile: (input) => rpc.getUserProfile(input),
    setUserProfile: (input) => rpc.setUserProfile(input),
    watchUserProfile: (input) => armed(rpc.watchUserProfile(input)),
    createTask: (input) => rpc.createTask(input),
    updateTask: (input) => rpc.updateTask(input),
    getTask: (input) => rpc.getTask(input),
    listTasks: (input) => rpc.listTasks(input),
    watchTasks: (input) => armed(rpc.watchTasks(input)),
    createPairingInvite: (input) => rpc.createPairingInvite(input),
    approvePairingRequest: (input) => rpc.approvePairingRequest(input),
    rejectPairingRequest: (input) => rpc.rejectPairingRequest(input),
    watchPairingRequests: (input) => armed(rpc.watchPairingRequests(input)),
  }
}
