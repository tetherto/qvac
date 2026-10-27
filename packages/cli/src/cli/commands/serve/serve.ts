type Invites = Awaited<ReturnType<typeof mintInvites>>
import type { CommandIO } from '../../io.js'
import type { Capabilities } from '@qvac/core/client'
import type { RuntimeOptions } from '../../../lib/types.js'
import type { CoreHost } from '../../../lib/types.js'
import b4a from 'b4a'
import { mintInvites } from '../invite/invites.js'
import { downloadMeter, progressReporter } from '../../progress.js'
import { setUp, markSetUp } from './setup.js'
import { readStatus, thisDevice } from '../../snapshot.js'
import { writeServeStatus, clearServeStatus } from '../status/status.js'

export async function serve(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  // the copy is for `qvac status` beside this host; a read racing a mesh change waits for the next
  const saveStatus = () => readStatus(host).then((s) => writeServeStatus(options.dataDir, s), noop)
  // a join can wait minutes for a peer, and status should say joining meanwhile, not nothing
  const joining = host.engine.meshesWatch({})
  joining.on('data', saveStatus)
  await saveStatus()
  const { created } = await setUp(host, options, io).finally(() => joining.destroy())
  // the row keeps the name setup gave it; the boot name is only this machine's default
  host.deviceName = await thisDevice(host)
  await openSharedMeshes(host.engine)
  const invites = await mintInvites(host.engine)
  announce(host, { invites, created, options, io })

  await saveStatus()
  const standing = watchStanding(host, {
    onPeers: (peerCount) => reportPeers(peerCount, { options, io }),
    // a join that completes or a member who arrives changes the copy as much as a peer does
    onStatus: saveStatus
  })
  const stopDownloads = watchDownloads(host, progressReporter(options, io))
  try {
    const end = await Promise.race([
      io.stopping.then(() => ({ code: 0, event: 'stopped', message: 'Stopped.' })),
      standing.kicked.then(() => unpaired(host)),
      host.exited.then(coreExited)
    ])
    if (options.json) {
      io.json({ event: end.event, code: end.code })
    } else {
      io.note(end.message)
    }

    return end.code
  } finally {
    standing.close()
    stopDownloads()
    clearServeStatus(options.dataDir)
  }
}

// A host keeps every mesh it serves replicating, not only the account it boots into.
async function openSharedMeshes(engine: Capabilities) {
  const { meshes } = await engine.listMeshes({})
  const closed = (meshes ?? []).filter((mesh) => !mesh.account && !mesh.compute && !mesh.open)
  await Promise.all(closed.map((mesh) => engine.openMesh({ meshId: mesh.meshId })))
}

function announce(
  host: CoreHost,
  {
    invites,
    created,
    options,
    io
  }: { invites: Invites; created: boolean; options: RuntimeOptions; io: CommandIO }
) {
  if (options.json) {
    io.json({
      status: 'ready',
      version: options.version,
      device: { id: b4a.toHex(b4a.from(host.deviceId!)), name: host.deviceName },
      storage: host.root,
      workspace: invites.workspace,
      created,
      invites: { device: invites.device, member: invites.member }
    })
    return
  }

  // links are asked for, never shown unasked: qvac invite, or Devices → Pair a device in the app
  const where = invites.workspace?.name ? ` in ${invites.workspace.name}` : ''
  io.line('')
  io.line(`QV.AC ${options.version} · ${host.deviceName} is serving${where}`)
  io.line(`State in ${host.root} · qvac status, qvac logs -f · Ctrl+C stops`)
}

// This device's own standing: peers coming and going, and being unpaired by another device.
function watchStanding(
  host: CoreHost,
  { onPeers, onStatus }: { onPeers(count: number): void; onStatus(): void }
) {
  const status = host.engine.meshStatusWatch({})
  let peers: number | null = null
  const kicked = new Promise<void>((resolve) => {
    status.on('data', ({ state, peerCount, kickedPending }) => {
      if (state === 'kicked' || kickedPending) {
        resolve()
      }

      if (peers !== null && peerCount !== peers) {
        onPeers(peerCount ?? 0)
      }

      peers = peerCount ?? 0
      onStatus()
    })
  })

  // a device paired through another one reaches this one only by replication, as a member does
  const devices = host.engine.account({}).then(({ meshId }) => {
    const watch = host.engine.devicesWatch({ meshId: meshId! })
    watch.on('data', onStatus)
    watch.on('error', noop)
    return watch
  }, noop)
  const members = new Map()
  const meshes = host.engine.meshesWatch({})
  meshes.on('data', ({ meshes: list = [] }) => {
    for (const { meshId, workspace } of list ?? []) {
      if (workspace && !members.has(meshId)) {
        const watch = host.engine.membersWatch({ meshId })
        watch.on('data', onStatus)
        watch.on('error', noop)
        members.set(meshId, watch)
      }
    }

    onStatus()
  })

  return {
    kicked,
    close: () => {
      status.destroy()
      meshes.destroy()
      for (const watch of members.values()) {
        watch.destroy()
      }

      devices.then((watch) => watch?.destroy())
    }
  }
}

function watchDownloads(host: CoreHost, report: ReturnType<typeof progressReporter>) {
  const downloads = host.engine.modelDownloadsWatch({})
  const meters = new Map<string, ReturnType<typeof downloadMeter>>()
  downloads.on('data', ({ downloads: rows }) => {
    for (const frame of rows ?? []) {
      if (!meters.has(frame.name)) {
        meters.set(frame.name, downloadMeter())
      }

      report(meters.get(frame.name)!(frame))
    }
  })

  return () => {
    report.end()
    downloads.destroy()
  }
}

function reportPeers(
  peerCount: number,
  { options, io }: { options: RuntimeOptions; io: CommandIO }
) {
  if (options.json) {
    return io.json({ event: 'peers', peerCount })
  }

  const peers = `${peerCount} ${peerCount === 1 ? 'peer' : 'peers'}`
  io.note(`${new Date().toISOString()}  ${peers} online`)
}

// Unpaired from another device: stop for good, so a restart policy does not bring it back.
async function unpaired(host: CoreHost) {
  await host.engine.acknowledgeKicked({})
  await markSetUp(host.engine, { done: false })

  return {
    code: 0,
    event: 'unpaired',
    message: `${host.deviceName} was unpaired from its workspace, so it stopped. qvac serve sets it up again.`
  }
}

function coreExited(code: number) {
  return {
    code: 1,
    event: 'core-exited',
    message: `Core stopped unexpectedly (exit ${code}). qvac logs shows why.`
  }
}

function noop() {}
