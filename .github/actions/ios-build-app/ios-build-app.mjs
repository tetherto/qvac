#!/usr/bin/env node
// Archives the built test app and exports a signed IPA with the imported profile.

import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function schemeFrom(list) {
  const lines = list.split('\n')
  const at = lines.findIndex((l) => l.trim() === 'Schemes:')
  const scheme = at < 0 ? '' : (lines[at + 1] || '').trim()
  if (!scheme) throw new Error('xcodebuild -list shows no scheme')
  return scheme
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function exportOptions({ method, teamId, bundleId, profileUuid }) {
  const kv = (k, v) => `  <key>${k}</key>\n  <string>${xml(v)}</string>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    kv('method', method),
    kv('teamID', teamId),
    kv('signingStyle', 'manual'),
    '  <key>provisioningProfiles</key>',
    '  <dict>',
    `  ${kv(bundleId, profileUuid).replaceAll('\n', '\n  ')}`,
    '  </dict>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const app = resolve(env.APP_DIR)
  const ios = join(app, 'ios')
  const run = (cmd, args, cwd = app) => execFileSync(cmd, args, { stdio: 'inherit', cwd })
  run('npx', ['expo', 'prebuild', '--platform', 'ios', '--clean'])
  run('pod', ['install', '--repo-update'], ios)
  run('npm', ['run', 'bundle'])
  const scheme = schemeFrom(execFileSync('xcodebuild', ['-list'], { cwd: ios, encoding: 'utf8' }))
  const archive = join(env.RUNNER_TEMP, `${scheme}.xcarchive`)
  run(
    'xcodebuild',
    [
      '-workspace',
      `${scheme}.xcworkspace`,
      '-scheme',
      scheme,
      '-sdk',
      'iphoneos',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      archive,
      'CODE_SIGN_STYLE=Manual',
      `PROVISIONING_PROFILE_SPECIFIER=${env.PROFILE_UUID}`,
      'CODE_SIGN_IDENTITY=Apple Distribution',
      `DEVELOPMENT_TEAM=${env.TEAM_ID}`,
      'clean',
      'archive'
    ],
    ios
  )
  const plist = join(env.RUNNER_TEMP, 'ExportOptions.plist')
  writeFileSync(
    plist,
    exportOptions({
      method: env.EXPORT_METHOD,
      teamId: env.TEAM_ID,
      bundleId: env.BUNDLE_ID,
      profileUuid: env.PROFILE_UUID
    })
  )
  const out = join(env.RUNNER_TEMP, 'build')
  run(
    'xcodebuild',
    ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', plist, '-exportPath', out],
    ios
  )
  const ipa = readdirSync(out, { recursive: true })
    .map(String)
    .find((f) => f.endsWith('.ipa'))
  if (!ipa) throw new Error(`no IPA under ${out}`)
  appendFileSync(
    env.GITHUB_OUTPUT,
    `app-path=${join(out, ipa)}\napp-type=IOS_APP\napp-name=test-app-iOS.ipa\n`
  )
}
