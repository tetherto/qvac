// Generated from schema/sync.ts. Do not edit.

import { pipeline, Readable } from 'streamx'

function noop() {}

export function bindApi(rpc, api) {
  if (api.getIdentity) rpc.onGetIdentity((input) => api.getIdentity(input))
  if (api.describeRuntime) rpc.onDescribeRuntime((input) => api.describeRuntime(input))
  if (api.getUserProfile) rpc.onGetUserProfile((input) => api.getUserProfile(input))
  if (api.setUserProfile) rpc.onSetUserProfile((input) => api.setUserProfile(input))
  if (api.watchUserProfile) rpc.onWatchUserProfile((out) => {
    const source = Readable.from(api.watchUserProfile(out.data))
    source.on('error', (error) => out.writeStream?.destroy(error))
    pipeline(source, out, noop)
    out.writeStream?.on('close', () => source.destroy())
  })
  if (api.createTask) rpc.onCreateTask((input) => api.createTask(input))
  if (api.updateTask) rpc.onUpdateTask((input) => api.updateTask(input))
  if (api.getTask) rpc.onGetTask((input) => api.getTask(input))
  if (api.listTasks) rpc.onListTasks((input) => api.listTasks(input))
  if (api.watchTasks) rpc.onWatchTasks((out) => {
    const source = Readable.from(api.watchTasks(out.data))
    source.on('error', (error) => out.writeStream?.destroy(error))
    pipeline(source, out, noop)
    out.writeStream?.on('close', () => source.destroy())
  })
  if (api.createPairingInvite) rpc.onCreatePairingInvite((input) => api.createPairingInvite(input))
  if (api.approvePairingRequest) rpc.onApprovePairingRequest((input) => api.approvePairingRequest(input))
  if (api.rejectPairingRequest) rpc.onRejectPairingRequest((input) => api.rejectPairingRequest(input))
  if (api.watchPairingRequests) rpc.onWatchPairingRequests((out) => {
    const source = Readable.from(api.watchPairingRequests(out.data))
    source.on('error', (error) => out.writeStream?.destroy(error))
    pipeline(source, out, noop)
    out.writeStream?.on('close', () => source.destroy())
  })
}
