#!/usr/bin/env node
// Flaky HTTP file server for the mobile download-resilience e2e tests.
//
// Runs on the desktop (the same host as the local MQTT broker). The device
// reaches it over the LAN at http://<broker-host>:<port>, where <broker-host>
// is what the consumer reads from EXPO_PUBLIC_MQTT_HOST. The bare worklet's
// fetch uses native sockets, which sit below the layer iOS ATS / Android
// cleartext policy governs, so the cleartext LAN download works without any
// app-level exemption.
//
// Routes:
//   GET|HEAD /netdrop/<nonce>   6 MB payload, Range support; trickles then
//                               severs the connection once after a byte
//                               threshold (models a mid-stream network drop).
//   GET|HEAD /suspend/<nonce>   same payload, but keeps trickling until told to
//                               sever via the control route (models the OS
//                               killing the socket while backgrounded).
//   GET /__control/sever?key=<path>   drop the active /suspend transfer.
//   GET /__control/reset              clear all per-key sever state.
//
// A resumed request (one carrying a Range header) is always served to
// completion, so a working retry/range-resume recovers. State is keyed by path,
// so each unique-nonce URL severs exactly once and tests stay independent.

import * as http from 'node:http'

const PORT = Number(process.env.QVAC_FLAKY_PORT || 8099)
const PAYLOAD_BYTES = 6 * 1024 * 1024
const SEVER_AT_BYTES = Math.floor(PAYLOAD_BYTES / 3)
const TRICKLE_CHUNK = Math.max(64 * 1024, Math.floor(SEVER_AT_BYTES / 8))
const TRICKLE_INTERVAL_MS = 40

function buildPayload (size) {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buf[i] = i & 0xff
  return buf
}

const PAYLOAD = buildPayload(PAYLOAD_BYTES)

function parseRangeStart (header) {
  if (!header) return 0
  const m = /bytes=(\d+)-/.exec(header)
  return m && m[1] ? parseInt(m[1], 10) : 0
}

// key (request path) -> one-shot sever flag + the response currently streaming
const state = new Map()

function keyState (key) {
  let s = state.get(key)
  if (!s) {
    s = { severedOnce: false, activeRes: null }
    state.set(key, s)
  }
  return s
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  if (pathname === '/__control/reset') {
    state.clear()
    res.writeHead(200)
    res.end('reset')
    return
  }

  if (pathname === '/__control/sever') {
    const key = url.searchParams.get('key') || ''
    const s = state.get(key)
    if (s && s.activeRes) {
      s.severedOnce = true
      s.activeRes.destroy()
      s.activeRes = null
    }
    res.writeHead(200)
    res.end('severed')
    return
  }

  const mode = pathname.startsWith('/netdrop/')
    ? 'auto'
    : pathname.startsWith('/suspend/')
      ? 'manual'
      : null

  if (!mode) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  const key = pathname
  const s = keyState(key)
  const total = PAYLOAD.length

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-length': String(total), 'accept-ranges': 'bytes' })
    res.end()
    return
  }

  const start = parseRangeStart(req.headers.range)
  const slice = PAYLOAD.subarray(start)

  if (start > 0) {
    res.writeHead(206, {
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${total - 1}/${total}`,
      'accept-ranges': 'bytes'
    })
  } else {
    res.writeHead(200, { 'content-length': String(total), 'accept-ranges': 'bytes' })
  }

  // A resumed (Range) request, or any request after the one sever, completes.
  if (start > 0 || s.severedOnce) {
    res.end(slice)
    return
  }

  s.activeRes = res
  // Manual (suspend) mode trickles in smaller chunks so the transfer stays
  // in-flight long enough for the consumer to suspend() and signal a sever.
  const chunk = mode === 'manual' ? 64 * 1024 : TRICKLE_CHUNK
  let offset = 0
  const pump = () => {
    if (res !== s.activeRes || res.destroyed) return
    if (mode === 'auto' && !s.severedOnce && offset >= SEVER_AT_BYTES) {
      s.severedOnce = true
      res.destroy()
      s.activeRes = null
      return
    }
    if (offset >= total) {
      res.end()
      s.activeRes = null
      return
    }
    res.write(PAYLOAD.subarray(offset, offset + chunk))
    offset += chunk
    setTimeout(pump, TRICKLE_INTERVAL_MS)
  }
  pump()
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} already in use — stop the other instance or set QVAC_FLAKY_PORT`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`flaky-lan-server listening on 0.0.0.0:${PORT}`)
  console.log(`  netdrop: http://<broker-host>:${PORT}/netdrop/<nonce>`)
  console.log(`  suspend: http://<broker-host>:${PORT}/suspend/<nonce>  (+ /__control/sever?key=/suspend/<nonce>)`)
})
