'use strict'

// Pure decision logic for where and how to fetch the BCI test fixtures.
// Kept free of node built-ins so the bare-run unit tests can require it.

const FIXTURES_REPO = 'tetherto/qvac'
const FIXTURES_RELEASE_TAG = 'bci-test-assets-v0.1.0'
const FIXTURES_ASSET_NAME = 'bci-test-fixtures.tar.gz'
const DIRECT_FIXTURES_URL = `https://github.com/${FIXTURES_REPO}/releases/download/${FIXTURES_RELEASE_TAG}/${FIXTURES_ASSET_NAME}`
const RELEASE_API_URL = `https://api.github.com/repos/${FIXTURES_REPO}/releases/tags/${FIXTURES_RELEASE_TAG}`

function githubToken (env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || ''
}

function apiHeaders (token) {
  return {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

// BCI_FIXTURES_URL always wins (plain fetch, no auth). With a GitHub token
// the asset is resolved through the release API: the repository is private,
// so its browser_download_url answers 404 to unauthenticated requests. The
// plain URL is still attempted without a token so an override-less run keeps
// working if the release ever becomes publicly reachable.
function resolveFixturesSource (env) {
  if (env.BCI_FIXTURES_URL) {
    return { kind: 'direct', url: env.BCI_FIXTURES_URL, headers: {} }
  }
  const token = githubToken(env)
  if (token) {
    return {
      kind: 'release-api',
      releaseUrl: RELEASE_API_URL,
      assetName: FIXTURES_ASSET_NAME,
      headers: apiHeaders(token)
    }
  }
  return { kind: 'direct', url: DIRECT_FIXTURES_URL, headers: {} }
}

function findAssetApiUrl (release, assetName) {
  const assets = (release && release.assets) || []
  const asset = assets.find((entry) => entry && entry.name === assetName)
  return asset ? asset.url : null
}

module.exports = {
  DIRECT_FIXTURES_URL,
  FIXTURES_ASSET_NAME,
  RELEASE_API_URL,
  findAssetApiUrl,
  resolveFixturesSource
}
