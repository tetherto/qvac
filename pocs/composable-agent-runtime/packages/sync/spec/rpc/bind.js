// Generated from schema/sync.ts. Do not edit.

import { pipeline, Readable } from 'streamx'

function noop() {}

export function bindApi(rpc, api) {
  if (api.getIdentity) rpc.onGetIdentity((input) => api.getIdentity(input))
  if (api.describeRuntime) rpc.onDescribeRuntime((input) => api.describeRuntime(input))
  if (api.runtimeStatus) rpc.onRuntimeStatus((input) => api.runtimeStatus(input))
  if (api.runtimeDiagnostics) rpc.onRuntimeDiagnostics((input) => api.runtimeDiagnostics(input))
  if (api.suspend) rpc.onSuspend((input) => api.suspend(input))
  if (api.resume) rpc.onResume((input) => api.resume(input))
  if (api.meshStatus) rpc.onMeshStatus((input) => api.meshStatus(input))
  if (api.watchMeshStatus) rpc.onWatchMeshStatus((out) => {
    const source = Readable.from(api.watchMeshStatus(out.data))
    source.on('error', (error) => out.writeStream?.destroy(error))
    pipeline(source, out, noop)
    out.writeStream?.on('close', () => source.destroy())
  })
  if (api.joinMesh) rpc.onJoinMesh((input) => api.joinMesh(input))
  if (api.cancelMeshJoin) rpc.onCancelMeshJoin((input) => api.cancelMeshJoin(input))
  if (api.leaveMesh) rpc.onLeaveMesh((input) => api.leaveMesh(input))
  if (api.listDevices) rpc.onListDevices((input) => api.listDevices(input))
  if (api.watchDevices) rpc.onWatchDevices((out) => {
    const source = Readable.from(api.watchDevices(out.data))
    source.on('error', (error) => out.writeStream?.destroy(error))
    pipeline(source, out, noop)
    out.writeStream?.on('close', () => source.destroy())
  })
  if (api.renameDevice) rpc.onRenameDevice((input) => api.renameDevice(input))
  if (api.removeDevice) rpc.onRemoveDevice((input) => api.removeDevice(input))
  if (api.createPairingInvite) rpc.onCreatePairingInvite((input) => api.createPairingInvite(input))
  if (api.approvePairingRequest) rpc.onApprovePairingRequest((input) => api.approvePairingRequest(input))
  if (api.rejectPairingRequest) rpc.onRejectPairingRequest((input) => api.rejectPairingRequest(input))
  if (api.watchPairingRequests) rpc.onWatchPairingRequests((out) => {
    const source = Readable.from(api.watchPairingRequests(out.data))
    source.on('error', (error) => out.writeStream?.destroy(error))
    pipeline(source, out, noop)
    out.writeStream?.on('close', () => source.destroy())
  })
  if (api.applyProfile) rpc.onApplyProfile((input) => api.applyProfile(input))
  if (api.queryProfile) rpc.onQueryProfile((input) => api.queryProfile(input))
  if (api.watchProfile) rpc.onWatchProfile((out) => {
    const source = Readable.from(api.watchProfile(out.data))
    source.on('error', (error) => out.writeStream?.destroy(error))
    pipeline(source, out, noop)
    out.writeStream?.on('close', () => source.destroy())
  })
}
