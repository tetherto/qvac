export const SPEECH_ADDONS = [
  { name: '@qvac/asr-ggml', dir: 'packages/asr-ggml' },
  { name: '@qvac/audiogen-ggml', dir: 'packages/audiogen-ggml' },
  { name: '@qvac/bci-whispercpp', dir: 'packages/bci-whispercpp' },
  { name: '@qvac/tts-ggml', dir: 'packages/tts-ggml' },
]

export const GGML_SPEECH_PORT = 'ggml-speech'
export const PINNED_PORTS = [GGML_SPEECH_PORT, 'speech-cpp']
export const BUILD_FIELD = 'qvac'

const OVERRIDE_VERSION_KEYS = ['version', 'version-date', 'version-semver', 'version-string']
const FLOOR_KEY = 'version>='
const DEFAULT_PORT_VERSION = 0

export function recordedGgmlSpeech(manifest) {
  return manifest?.[BUILD_FIELD]?.[GGML_SPEECH_PORT] ?? null
}

export function formatPortVersion(entry) {
  const versionKey = OVERRIDE_VERSION_KEYS.find((key) => entry[key] !== undefined)
  const portVersion = entry['port-version'] ?? DEFAULT_PORT_VERSION
  return portVersion === DEFAULT_PORT_VERSION ? entry[versionKey] : `${entry[versionKey]}#${portVersion}`
}

export function findPin(vcpkgManifest, port) {
  const entries = (vcpkgManifest.overrides ?? []).filter((entry) => entry.name === port)
  return entries.length === 1 ? formatPortVersion(entries[0]) : null
}

export function groupBy(items, keyOf, valueOf) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), valueOf(item)])
  }
  return groups
}

export function formatGroups(groups) {
  return [...groups].map(([key, labels]) => `${key} (${labels.join(', ')})`).join('; ')
}

function listFeatureDependencies(vcpkgManifest) {
  return Object.values(vcpkgManifest.features ?? {}).flatMap((feature) => feature.dependencies ?? [])
}

function listDependencies(vcpkgManifest) {
  return [...(vcpkgManifest.dependencies ?? []), ...listFeatureDependencies(vcpkgManifest)]
}

function dependencyName(dependency) {
  return typeof dependency === 'string' ? dependency : dependency?.name
}

export function dependsOnPinnedPorts(vcpkgManifest) {
  return listDependencies(vcpkgManifest).some((dependency) => PINNED_PORTS.includes(dependencyName(dependency)))
}

function listPinnedFloors(vcpkgManifest) {
  return listDependencies(vcpkgManifest).filter(
    (dependency) => PINNED_PORTS.includes(dependencyName(dependency)) && dependency[FLOOR_KEY] !== undefined,
  )
}

function checkMissingPins(addon) {
  return PINNED_PORTS.filter((port) => findPin(addon.vcpkg, port) === null).map(
    (port) => `${addon.name}: vcpkg.json needs exactly one overrides entry for ${port}`,
  )
}

function checkPinnedFloors(addon) {
  const floors = new Set(listPinnedFloors(addon.vcpkg).map((dependency) => `${dependency.name} ${FLOOR_KEY} ${dependency[FLOOR_KEY]}`))
  return [...floors].map(
    (floor) => `${addon.name}: vcpkg.json declares ${floor}; set the version in its overrides entry instead`,
  )
}

function checkRecordedPin(addon) {
  const pin = findPin(addon.vcpkg, GGML_SPEECH_PORT)
  const recorded = recordedGgmlSpeech(addon.manifest)
  if (pin === null || recorded === pin) return []
  return [
    `${addon.name}: package.json ${BUILD_FIELD}["${GGML_SPEECH_PORT}"] is ${recorded ?? 'missing'}, ` +
      `but vcpkg.json pins ${GGML_SPEECH_PORT} ${pin}`,
  ]
}

function checkPortLockstep(addons, port) {
  const pinned = addons.filter((addon) => findPin(addon.vcpkg, port) !== null)
  const groups = groupBy(pinned, (addon) => findPin(addon.vcpkg, port), (addon) => addon.name)
  return groups.size > 1 ? [`${port} is pinned to ${groups.size} versions: ${formatGroups(groups)}`] : []
}

export function checkAddonList(packages) {
  const listed = new Set(SPEECH_ADDONS.map((addon) => addon.dir))
  return packages
    .filter((pkg) => !listed.has(pkg.dir) && dependsOnPinnedPorts(pkg.vcpkg))
    .map(
      (pkg) =>
        `${pkg.dir} depends on ${PINNED_PORTS.join(' or ')} but is not a listed speech addon; add it to ` +
        'SPEECH_ADDONS in .github/scripts/lib/speech-ggml.mjs and in build-mobile-app/check-speech-ggml-builds.mjs',
    )
}

export function checkPins(addons) {
  return [
    ...addons.flatMap(checkMissingPins),
    ...addons.flatMap(checkPinnedFloors),
    ...addons.flatMap(checkRecordedPin),
    ...PINNED_PORTS.flatMap((port) => checkPortLockstep(addons, port)),
  ]
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parsePlannedPort(planOutput, port) {
  const pattern = new RegExp(`^[\\s*]*${escapeRegExp(port)}(?:\\[([^\\]]*)\\])?:(\\S+)@(\\S+)`, 'm')
  const match = planOutput.match(pattern)
  if (!match) return null
  const features = (match[1] ?? '').split(',').filter(Boolean).sort()
  return { features, triplet: match[2], version: match[3] }
}

export function formatPlannedPort(port, planned) {
  const features = planned.features.length > 0 ? `[${planned.features.join(',')}]` : ''
  return `${port}${features}@${planned.version}`
}

function formatGgmlSpeechPlan(plan) {
  return formatPlannedPort(GGML_SPEECH_PORT, plan.planned)
}

function checkTripletBuilds(triplet, plans) {
  const groups = groupBy(plans, formatGgmlSpeechPlan, (plan) => plan.addon)
  if (groups.size <= 1) return []
  return [`${triplet}: the speech addons plan ${groups.size} ${GGML_SPEECH_PORT} builds: ${formatGroups(groups)}`]
}

function checkPlannedVersions(plans, pin) {
  return plans
    .filter((plan) => plan.planned.version !== pin)
    .map(
      (plan) =>
        `${plan.triplet}: ${plan.addon} plans ${GGML_SPEECH_PORT}@${plan.planned.version}, but the override pins ${pin}`,
    )
}

export function checkPlans(plans, pin) {
  const byTriplet = groupBy(plans, (plan) => plan.triplet, (plan) => plan)
  return [
    ...[...byTriplet].flatMap(([triplet, tripletPlans]) => checkTripletBuilds(triplet, tripletPlans)),
    ...checkPlannedVersions(plans, pin),
  ]
}

export function summarizePlans(plans) {
  const byTriplet = groupBy(plans, (plan) => plan.triplet, formatGgmlSpeechPlan)
  return [...byTriplet].map(([triplet, builds]) => `${triplet}: ${[...new Set(builds)].join(' | ')}`)
}

const UNRECORDED_LABEL = 'not recorded'

export function listInstalledBuilds(installed, readBuild) {
  return [...installed].flatMap(([name, versions]) =>
    [...versions.keys()].map((version) => ({ id: `${name}@${version}`, ggmlSpeech: readBuild(name, version) })),
  )
}

export function summarizeRecordedBuilds(builds) {
  if (builds.length === 0) return `${GGML_SPEECH_PORT}: no speech addons installed`
  const groups = groupBy(builds, (build) => build.ggmlSpeech ?? UNRECORDED_LABEL, (build) => build.id)
  return `${GGML_SPEECH_PORT}: ${formatGroups(groups)}`
}

function checkRecordedConflicts(recorded) {
  const groups = groupBy(recorded, (build) => build.ggmlSpeech, (build) => build.id)
  if (groups.size <= 1) return []
  return [`speech addons built from ${groups.size} ${GGML_SPEECH_PORT} versions: ${formatGroups(groups)}`]
}

function warnUnrecorded(unrecorded) {
  return unrecorded.map(
    (build) => `${build.id} does not record the ${GGML_SPEECH_PORT} build it ships, so it cannot be checked`,
  )
}

export function checkRecordedBuilds(builds) {
  if (builds.length <= 1) return { errors: [], warnings: [] }
  return {
    errors: checkRecordedConflicts(builds.filter((build) => build.ggmlSpeech !== null)),
    warnings: warnUnrecorded(builds.filter((build) => build.ggmlSpeech === null)),
  }
}
